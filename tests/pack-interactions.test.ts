/**
 * 整合包互动：有帮助、举报（pack_release）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertPlugin, insertRepository, insertUser, type TestDb } from './support/db';
import { createPacksService } from '../src/server/modules/packs';
import { createInteractionsService } from '../src/server/modules/interactions';
import type { CallerContext } from '../src/server/platform/context';
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

async function makePublished(
  db: TestDb['db'],
  author: string,
): Promise<{ packId: string; releaseId: string }> {
  const repo = insertRepository(db);
  const plugin = insertPlugin(db, repo, '.');
  return createPacksService({ db }).createPackWithFirstRelease(
    caller(db, author),
    {
      title: '包',
      purpose: '用途',
      bodyMarkdown: '说明',
      dshVersion: V,
      configTemplate: null,
      testStatus: 'untested',
      testTask: null,
      testResult: null,
      items: [{ pluginId: plugin, pluginVersion: V, installTarget: null }],
    },
    db,
  );
}

describe('整合包互动', () => {
  it('有帮助：匿名只给总数；登录切换并计数', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const user = insertUser(db);
    const { releaseId } = await makePublished(db, author);
    const service = createPacksService({ db });

    expect(await service.helpfulStateForRelease(releaseId, null, db)).toEqual({ helpful: false, count: 0 });
    expect(await service.toggleHelpfulForRelease(caller(db, user), releaseId, db)).toEqual({
      helpful: true,
      count: 1,
    });
    expect(await service.helpfulStateForRelease(releaseId, user, db)).toEqual({ helpful: true, count: 1 });
    expect(await service.toggleHelpfulForRelease(caller(db, user), releaseId, db)).toEqual({
      helpful: false,
      count: 0,
    });
  });

  it('举报：已发布版本可举报；未发布草稿拒绝', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const user = insertUser(db);
    const published = await makePublished(db, author);
    const interactions = createInteractionsService({ db });

    const report = await interactions.createReport(
      caller(db, user),
      { targetKind: 'pack_release', targetId: published.releaseId, reason: 'spam' },
      db,
    );
    expect(report.created).toBe(true);

    // 草稿版本不可举报
    const packs = createPacksService({ db });
    const draft = await packs.createPackDraft(
      caller(db, author),
      {
        title: '草稿',
        purpose: '用途',
        bodyMarkdown: '说明',
        dshVersion: V,
        configTemplate: null,
        testStatus: 'untested',
        testTask: null,
        testResult: null,
        items: [{ pluginId: insertPlugin(db, insertRepository(db), '.'), pluginVersion: V, installTarget: null }],
      },
      db,
    );
    try {
      await interactions.createReport(
        caller(db, user),
        { targetKind: 'pack_release', targetId: draft.releaseId, reason: 'spam' },
        db,
      );
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.TARGET_UNAVAILABLE);
    }
  });
});
