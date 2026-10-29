/**
 * 整合包生命周期：草稿 → 提交 → 自动检查 → 发布 / 提示补充 / 转人工。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertPlugin, insertRepository, insertUser, type TestDb } from './support/db';
import { createPacksService } from '../src/server/modules/packs';
import { createNotificationsService } from '../src/server/modules/notifications';
import type { CallerContext } from '@/server/platform/context';
import type { VersionValue } from '@/packages/common/field-rules';
import type { InstallTarget } from '@/packages/common/pack-install';
import { ErrorCodes, isDomainError } from '../src/packages/common/errors';

let ctx: TestDb | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function caller(db: TestDb['db'], userId: string): CallerContext {
  const row = db.prepare('SELECT role, account_status FROM users WHERE id = ?').get(userId) as {
    role: 'user' | 'admin';
    account_status: 'active' | 'disabled';
  };
  return { userId, role: row.role, accountStatus: row.account_status };
}

const V: VersionValue = { kind: 'known', value: '1.0.0' };
const LONG_BODY = '先安装记忆插件，再安装检索插件，最后按说明顺序完成配置。';

function input(
  pluginId: string,
  overrides: { title?: string; body?: string; installTarget?: InstallTarget | null } = {},
) {
  return {
    title: overrides.title ?? '组合包',
    purpose: '科研资料整理与检索的固定组合',
    bodyMarkdown: overrides.body ?? LONG_BODY,
    dshVersion: V,
    configTemplate: null,
    testStatus: 'untested' as const,
    testTask: null,
    testResult: null,
    items: [{ pluginId, pluginVersion: V, installTarget: overrides.installTarget ?? null }],
  };
}

async function makeDraft(
  db: TestDb['db'],
  author: string,
  overrides: { title?: string; body?: string } = {},
): Promise<{ packId: string; releaseId: string; pluginId: string }> {
  const repo = insertRepository(db);
  const plugin = insertPlugin(db, repo, '.');
  const created = await createPacksService({ db }).createPackDraft(caller(db, author), input(plugin, overrides), db);
  return { ...created, pluginId: plugin };
}

describe('整合包发布流程', () => {
  it('草稿不公开；说明不足提示补充；补充后提交自动发布', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const draft = await makeDraft(db, author, { body: '太短' });
    const service = createPacksService({ db });

    expect((await service.listPublicPacks({}, db)).items).toHaveLength(0);
    expect((await service.getPack(caller(db, author), draft.packId, {}, db)).selected).toBeNull();

    const needsInfo = await service.submitReleaseForReview(caller(db, author), draft.releaseId, db);
    expect(needsInfo.outcome).toBe('needs_info');
    expect(needsInfo.reviewStatus).toBe('rejected');
    expect(needsInfo.note).toContain('说明');

    await service.updateDraftRelease(caller(db, author), draft.releaseId, input(draft.pluginId), db);
    const published = await service.submitReleaseForReview(caller(db, author), draft.releaseId, db);
    expect(published.outcome).toBe('pass');
    expect(published.reviewStatus).toBe('published');
    expect(published.releaseNumber).toBe(1);
    expect((await service.listPublicPacks({}, db)).items).toHaveLength(1);

    // 提交时记录安装核验（结构核验）
    const checks = db
      .prepare(
        `SELECT COUNT(*) AS c FROM plugin_install_checks ic
           JOIN plugin_pack_release_items i ON i.id = ic.release_item_id
          WHERE i.release_id = ?`,
      )
      .get(draft.releaseId) as { c: number };
    expect(checks.c).toBeGreaterThan(0);
  });

  it('带外链转人工；管理员通过后发布；已发布不可编辑', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const admin = insertUser(db, { role: 'admin' });
    const draft = await makeDraft(db, author, {
      body: '先安装记忆插件，再安装检索插件，详见 https://example.com/guide 的步骤。',
    });
    const service = createPacksService({ db });

    const manual = await service.submitReleaseForReview(caller(db, author), draft.releaseId, db);
    expect(manual.outcome).toBe('manual');
    expect(manual.reviewStatus).toBe('pending');

    const approved = await service.approveRelease(caller(db, admin), draft.releaseId, db);
    expect(approved.releaseNumber).toBe(1);

    // 审核结果通知：作者收到 moderation_result，且链接指向整合包版本
    const inbox = await createNotificationsService({ db }).list(author, { limit: 20 });
    const notice = inbox.items.find((item) => item.kind === 'moderation_result');
    expect(notice?.href).toBe(`/packs/${draft.packId}?v=1`);

    try {
      await service.updateDraftRelease(caller(db, author), draft.releaseId, input(draft.pluginId), db);
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.VERSION_CONFLICT);
    }
  });

  it('安装核验：npm 版本存在则发布；不存在则提示补充', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo, '.');
    const service = createPacksService({ db });
    const draft = await service.createPackDraft(
      caller(db, author),
      input(plugin, {
        installTarget: { kind: 'npm', packageName: 'dsh-memory', version: '1.0.0' },
      }),
      db,
    );

    const submitted = await service.submitReleaseForReview(caller(db, author), draft.releaseId, db);
    expect(submitted.outcome).toBe('verifying');

    const fakeFetch = async (url: string) =>
      url.includes('registry.npmjs.org')
        ? { ok: true, status: 200, body: { versions: { '1.0.0': {} } } }
        : { ok: true, status: 200, body: null };

    expect((await service.verifyPendingChecks(draft.releaseId, db, fakeFetch)).outcome).toBe('pass');
    expect((await service.listPublicPacks({}, db)).items).toHaveLength(1);

    // 第二包：版本不存在 → 提示补充
    const plugin2 = insertPlugin(db, insertRepository(db), '.');
    const second = await service.createPackDraft(
      caller(db, author),
      input(plugin2, {
        installTarget: { kind: 'npm', packageName: 'dsh-memory', version: '9.9.9' },
      }),
      db,
    );
    await service.submitReleaseForReview(caller(db, author), second.releaseId, db);
    expect((await service.verifyPendingChecks(second.releaseId, db, fakeFetch)).outcome).toBe('needs_info');
    const row = db
      .prepare('SELECT review_status, review_note FROM plugin_pack_releases WHERE id = ?')
      .get(second.releaseId) as { review_status: string; review_note: string | null };
    expect(row.review_status).toBe('rejected');
    expect(row.review_note).toContain('核验未通过');
  });

  it('自动分支用系统账号通知作者：需补充 / 核验通过 / 核验未通过', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const service = createPacksService({ db });
    const inbox = () => createNotificationsService({ db }).list(author, { limit: 20 });

    // 1) 说明太短 → needs_info，作者收到系统通知
    const shortDraft = await makeDraft(db, author, { body: '太短' });
    await service.submitReleaseForReview(caller(db, author), shortDraft.releaseId, db);
    const needsInfoNotice = (await inbox()).items.find((item) => item.excerpt?.includes('未通过自动检查'));
    expect(needsInfoNotice).toBeTruthy();
    expect(needsInfoNotice?.actorNickname).toBe('系统');
    expect(needsInfoNotice?.href).toBe(`/packs/${shortDraft.packId}`);

    // 2) 核验通过 → 系统通知「已发布」
    const repo = insertRepository(db);
    const okPlugin = insertPlugin(db, repo, '.');
    const okDraft = await service.createPackDraft(
      caller(db, author),
      input(okPlugin, { installTarget: { kind: 'npm', packageName: 'dsh-memory', version: '1.0.0' } }),
      db,
    );
    await service.submitReleaseForReview(caller(db, author), okDraft.releaseId, db);
    const fakeFetch = async (url: string) =>
      url.includes('registry.npmjs.org')
        ? { ok: true, status: 200, body: { versions: { '1.0.0': {} } } }
        : { ok: true, status: 200, body: null };
    expect((await service.verifyPendingChecks(okDraft.releaseId, db, fakeFetch)).outcome).toBe('pass');
    const publishedNotice = (await inbox()).items.find((item) => item.excerpt?.includes('核验通过，已发布'));
    expect(publishedNotice).toBeTruthy();
    expect(publishedNotice?.actorNickname).toBe('系统');

    // 3) 核验未通过 → 系统通知「未通过安装资料核验」
    const badDraft = await service.createPackDraft(
      caller(db, author),
      input(insertPlugin(db, insertRepository(db), '.'), {
        installTarget: { kind: 'npm', packageName: 'dsh-memory', version: '9.9.9' },
      }),
      db,
    );
    await service.submitReleaseForReview(caller(db, author), badDraft.releaseId, db);
    expect((await service.verifyPendingChecks(badDraft.releaseId, db, fakeFetch)).outcome).toBe('needs_info');
    const failedNotice = (await inbox()).items.find((item) => item.excerpt?.includes('未通过安装资料核验'));
    expect(failedNotice).toBeTruthy();

    // 全部来自系统账号（不是作者自己）
    for (const item of await inbox().then((r) => r.items)) {
      expect(item.actorNickname).toBe('系统');
    }
  });

  it('删除草稿；已发布只能撤回', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const draft = await makeDraft(db, author);
    const service = createPacksService({ db });

    await service.deleteDraftRelease(caller(db, author), draft.releaseId, db);
    expect(db.prepare('SELECT COUNT(*) AS c FROM plugin_pack_releases WHERE id = ?').get(draft.releaseId)).toEqual({ c: 0 });

    const second = await makeDraft(db, author);
    await service.submitReleaseForReview(caller(db, author), second.releaseId, db);
    expect((await service.listPublicPacks({}, db)).items).toHaveLength(1);

    try {
      await service.deleteDraftRelease(caller(db, author), second.releaseId, db);
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.VERSION_CONFLICT);
    }

    await service.withdrawRelease(caller(db, author), second.packId, second.releaseId, null, db);
    expect((await service.listPublicPacks({}, db)).items).toHaveLength(0);
  });

  it('非作者不能提交/编辑/删除；非管理员不能审核转人工版本', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const other = insertUser(db);
    const draft = await makeDraft(db, author, {
      body: '先安装记忆插件，再安装检索插件，详见 https://example.com/guide 的步骤。',
    });
    const service = createPacksService({ db });

    for (const promise of [
      service.submitReleaseForReview(caller(db, other), draft.releaseId, db),
      service.updateDraftRelease(caller(db, other), draft.releaseId, input(draft.pluginId), db),
      service.deleteDraftRelease(caller(db, other), draft.releaseId, db),
    ]) {
      try {
        await promise;
        throw new Error('应当被拒绝');
      } catch (e) {
        expect(isDomainError(e)).toBe(true);
        if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.FORBIDDEN);
      }
    }

    await service.submitReleaseForReview(caller(db, author), draft.releaseId, db);
    try {
      await service.approveRelease(caller(db, author), draft.releaseId, db);
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.FORBIDDEN);
    }
  });
});
