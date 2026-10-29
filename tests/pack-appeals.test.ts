/**
 * 整合包复核申请（申诉）：作者提交 → 管理员改判/维持 → 结果通知。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertPlugin, insertRepository, insertUser, type TestDb } from './support/db';
import { createPacksService } from '../src/server/modules/packs';
import { createNotificationsService } from '../src/server/modules/notifications';
import type { CallerContext } from '@/server/platform/context';
import type { VersionValue } from '@/packages/common/field-rules';
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

/** 造一个「说明太短 → 自动检查退回」的版本，处于 rejected 状态。 */
async function rejectedRelease(db: TestDb['db'], author: string): Promise<{ packId: string; releaseId: string }> {
  const plugin = insertPlugin(db, insertRepository(db), '.');
  const service = createPacksService({ db });
  const draft = await service.createPackDraft(
    caller(db, author),
    {
      title: '组合包',
      purpose: '科研资料整理与检索',
      bodyMarkdown: '太短',
      dshVersion: V,
      configTemplate: null,
      testStatus: 'untested',
      testTask: null,
      testResult: null,
      items: [{ pluginId: plugin, pluginVersion: V, installTarget: null }],
    },
    db,
  );
  const submitted = await service.submitReleaseForReview(caller(db, author), draft.releaseId, db);
  expect(submitted.outcome).toBe('needs_info');
  return draft;
}

describe('整合包复核申请', () => {
  it('作者可对被退回的版本申诉；同一版本同时只能有一条待处理', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const service = createPacksService({ db });
    const { releaseId } = await rejectedRelease(db, author);

    await service.submitAppeal(caller(db, author), releaseId, '说明文字已经足够了，规则误判。', db);
    const pending = db
      .prepare("SELECT COUNT(*) AS c FROM plugin_pack_appeals WHERE state = 'pending'")
      .get() as { c: number };
    expect(pending.c).toBe(1);

    try {
      await service.submitAppeal(caller(db, author), releaseId, '再申诉一次。', db);
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.VERSION_CONFLICT);
    }

    // 申诉说明太短 → 输入错误
    const other = await rejectedRelease(db, author);
    try {
      await service.submitAppeal(caller(db, author), other.releaseId, '短', db);
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.INPUT_INVALID);
    }
  });

  it('非作者不能申诉；已发布版本不能申诉', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const other = insertUser(db);
    const service = createPacksService({ db });
    const { releaseId } = await rejectedRelease(db, author);

    try {
      await service.submitAppeal(caller(db, other), releaseId, '我也想申诉。', db);
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.FORBIDDEN);
    }

    // 发布后的版本没有可申诉的判定
    const admin = insertUser(db, { role: 'admin' });
    const published = await rejectedRelease(db, author);
    await service.submitAppeal(caller(db, author), published.releaseId, '先申诉，再改判。', db);
    const appealId = (
      db.prepare('SELECT id FROM plugin_pack_appeals WHERE release_id = ?').get(published.releaseId) as {
        id: string;
      }
    ).id;
    await service.resolveAppeal(caller(db, admin), appealId, 'overturn', '确实误判。', db);

    try {
      await service.submitAppeal(caller(db, author), published.releaseId, '已发布还想申诉。', db);
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.VERSION_CONFLICT);
    }
  });

  it('管理员改判：版本发布、申诉记 overturned、作者收到通知', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const admin = insertUser(db, { role: 'admin' });
    const service = createPacksService({ db });
    const { packId, releaseId } = await rejectedRelease(db, author);

    await service.submitAppeal(caller(db, author), releaseId, '规则误判，说明已足够。', db);
    const [appeal] = await service.listPendingAppeals(db);
    expect(appeal.releaseId).toBe(releaseId);
    expect(appeal.snapshotNote).toContain('说明');

    const result = await service.resolveAppeal(caller(db, admin), appeal.appealId, 'overturn', '确实误判，予以发布。', db);
    expect(result.state).toBe('overturned');
    expect(result.releaseNumber).toBe(1);

    const row = db
      .prepare('SELECT review_status, release_number FROM plugin_pack_releases WHERE id = ?')
      .get(releaseId) as { review_status: string; release_number: number };
    expect(row.review_status).toBe('published');
    expect(Number(row.release_number)).toBe(1);

    const inbox = await createNotificationsService({ db }).list(author, { limit: 20 });
    const notice = inbox.items.find((item) => item.excerpt?.includes('改判成立'));
    expect(notice).toBeTruthy();
    expect(notice?.href).toBe(`/packs/${packId}?v=1`);

    // 待处理队列清空，历史里留痕
    expect(await service.listPendingAppeals(db)).toHaveLength(0);
    const history = await service.listAppealsForRelease(caller(db, author), releaseId, db);
    expect(history).toHaveLength(1);
    expect(history[0].state).toBe('overturned');
    expect(history[0].resolutionNote).toContain('误判');
  });

  it('管理员维持原判：必须写理由；版本保持退回；作者收到理由', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const admin = insertUser(db, { role: 'admin' });
    const service = createPacksService({ db });
    const { releaseId } = await rejectedRelease(db, author);

    await service.submitAppeal(caller(db, author), releaseId, '我认为说明够了。', db);
    const [appeal] = await service.listPendingAppeals(db);

    try {
      await service.resolveAppeal(caller(db, admin), appeal.appealId, 'uphold', '   ', db);
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.INPUT_INVALID);
    }

    const result = await service.resolveAppeal(
      caller(db, admin),
      appeal.appealId,
      'uphold',
      '说明里仍缺少安装步骤，请补充后再提交。',
      db,
    );
    expect(result.state).toBe('upheld');

    const row = db.prepare('SELECT review_status FROM plugin_pack_releases WHERE id = ?').get(releaseId) as {
      review_status: string;
    };
    expect(row.review_status).toBe('rejected');

    const inbox = await createNotificationsService({ db }).list(author, { limit: 20 });
    const notice = inbox.items.find((item) => item.excerpt?.includes('维持原判'));
    expect(notice).toBeTruthy();
    expect(notice?.excerpt).toContain('安装步骤');

    // 已处理的申诉不能再处理一次
    try {
      await service.resolveAppeal(caller(db, admin), appeal.appealId, 'overturn', null, db);
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.VERSION_CONFLICT);
    }
  });

  it('非管理员不能处理复核申请', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const service = createPacksService({ db });
    const { releaseId } = await rejectedRelease(db, author);
    await service.submitAppeal(caller(db, author), releaseId, '规则误判。', db);
    const [appeal] = await service.listPendingAppeals(db);

    try {
      await service.resolveAppeal(caller(db, author), appeal.appealId, 'overturn', null, db);
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.FORBIDDEN);
    }
  });
});
