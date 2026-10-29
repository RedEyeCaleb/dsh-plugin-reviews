/**
 * 整合包（迁移 0020/0021）：版本快照、序号分配、可见性、安装命令。
 *
 * 这一组测试专门盯住三件最容易写错的事：
 *  1. **发布即冻结**：发新版后旧版内容与条目不得改变；
 *  2. **序号与回退**：撤回最新版后默认入口回退，指定旧版能读到旧版内容；
 *  3. **命令是派生物**：目标不确认就没有命令（待核实），批量复制不含待核实项。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  insertPlugin,
  insertRepository,
  insertUser,
  type TestDb,
} from './support/db';
import { createPacksService } from '../src/server/modules/packs';
import { contentService } from '../src/server/modules/content';
import { buildInstallCommands, normalizeInstallTarget, type InstallTarget } from '../src/packages/common/pack-install';
import type { CallerContext } from '@/server/platform/context';
import type { VersionValue } from '@/packages/common/field-rules';

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

const V_KNOWN = (value: string): VersionValue => ({ kind: 'known', value });
const V_UNKNOWN = (): VersionValue => ({ kind: 'unknown' });

const NPM_TARGET: InstallTarget = { kind: 'npm', packageName: 'dsh-memory', version: '0.9.6' };
const GITHUB_TARGET: InstallTarget = {
  kind: 'github',
  repository: 'RestRegular/dsh-memory',
  commit: '0123456789abcdef0123456789abcdef01234567',
  pluginPath: 'source/memory-plugin',
};

function seedPlugins(db: TestDb['db'], count = 3): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const repoId = insertRepository(db, `gh-pack-${i}-${Math.random().toString(16).slice(2)}`);
    ids.push(insertPlugin(db, repoId, i === 0 ? '.' : `plugins/p${i}`));
  }
  return ids;
}

function releaseInput(
  pluginIds: string[],
  overrides: Partial<{
    title: string;
    purpose: string;
    bodyMarkdown: string;
    testStatus: 'untested' | 'tested';
    testTask: string | null;
    testResult: string | null;
    items: Array<{
      pluginId: string;
      pluginVersion: VersionValue;
      installTarget: InstallTarget | null;
      purpose?: string | null;
    }>;
  }> = {},
) {
  return {
    title: overrides.title ?? '科研资料整理套装',
    purpose: overrides.purpose ?? '把检索、记忆与整理串成一条流水线',
    bodyMarkdown: overrides.bodyMarkdown ?? '# 组合说明\n\n先装记忆，再装检索。',
    dshVersion: V_KNOWN('1.2.0'),
    configTemplate: null,
    testStatus: overrides.testStatus ?? ('untested' as const),
    testTask: overrides.testTask ?? null,
    testResult: overrides.testResult ?? null,
    items:
      overrides.items ??
      pluginIds.map((pluginId, index) => ({
        pluginId,
        pluginVersion: V_KNOWN(`0.${index}.0`),
        installTarget: index === 0 ? NPM_TARGET : index === 1 ? GITHUB_TARGET : null,
      })),
  };
}

describe('整合包：发布与快照', () => {
  it('创建第 1 版：包/版本/公共内容/条目都落库，详情返回可复制命令与待核实项', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createPacksService({ db });
    const author = insertUser(db, { nickname: '作者' });
    const plugins = seedPlugins(db, 3);

    const created = await service.createPackWithFirstRelease(caller(db, author), releaseInput(plugins), db);
    expect(created.releaseNumber).toBe(1);

    // 公共内容：pack_release，且 pack_release_id = id
    const entity = db
      .prepare('SELECT content_type, pack_release_id, author_id FROM content_entities WHERE id = ?')
      .get(created.releaseId) as { content_type: string; pack_release_id: string; author_id: string };
    expect(entity).toEqual({ content_type: 'pack_release', pack_release_id: created.releaseId, author_id: author });

    const detail = await service.getPack(caller(db, author), created.packId, {}, db);
    expect(detail.selected?.releaseNumber).toBe(1);
    expect(detail.selected?.items).toHaveLength(3);
    expect(detail.selected?.items[0]!.command).toBe(
      'dsh plugin --profile <profile> add dsh-memory@0.9.6 --save-exact',
    );
    expect(detail.selected?.items[1]!.command).toBe(
      `dsh plugin --profile <profile> add github:${GITHUB_TARGET.kind === 'github' ? GITHUB_TARGET.repository : ''}#0123456789abcdef0123456789abcdef01234567 --save-exact`,
    );
    // 第三条没有安装目标 → 待核实，没有命令
    expect(detail.selected?.items[2]!.command).toBeNull();
    expect(detail.selected?.items[2]!.pendingReason).toContain('待核实');
    expect(detail.selected?.commands.pendingCount).toBe(1);
    expect(detail.selected?.commands.copyAll.split('\n')).toHaveLength(2);
  });

  it('发布新版：旧版本内容与条目**一个字都不变**', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createPacksService({ db });
    const author = insertUser(db, { nickname: '作者' });
    const plugins = seedPlugins(db, 3);

    const first = await service.createPackWithFirstRelease(caller(db, author), releaseInput(plugins), db);
    const second = await service.addRelease(
      caller(db, author),
      first.packId,
      releaseInput([plugins[0]!], { title: '第二版：只留记忆', purpose: '精简版' }),
      db,
    );
    expect(second.releaseNumber).toBe(2);

    const v1 = await service.getPack(caller(db, author), first.packId, { releaseNumber: 1 }, db);
    expect(v1.selected?.title).toBe('科研资料整理套装');
    expect(v1.selected?.items).toHaveLength(3);

    const v2 = await service.getPack(caller(db, author), first.packId, { releaseNumber: 2 }, db);
    expect(v2.selected?.title).toBe('第二版：只留记忆');
    expect(v2.selected?.items).toHaveLength(1);

    // 默认入口是最新公开版
    const latest = await service.getPack(caller(db, author), first.packId, {}, db);
    expect(latest.selected?.releaseNumber).toBe(2);
    expect(latest.fellBack).toBe(false);
  });

  it('撤回最新版：默认回退到上一版；指定被撤回版本时如实标记不可用', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createPacksService({ db });
    const author = insertUser(db, { nickname: '作者' });
    const reader = insertUser(db, { nickname: '读者' });
    const plugins = seedPlugins(db, 2);

    const first = await service.createPackWithFirstRelease(caller(db, author), releaseInput(plugins), db);
    const second = await service.addRelease(
      caller(db, author),
      first.packId,
      releaseInput(plugins, { title: '第二版' }),
      db,
    );

    await service.withdrawRelease(caller(db, author), first.packId, second.releaseId, '写错了', db);

    const fallback = await service.getPack(caller(db, reader), first.packId, {}, db);
    expect(fallback.selected?.releaseNumber).toBe(1);
    expect(fallback.fellBack).toBe(true);

    // 读者指定被撤回的版本：不返回正文，但告诉页面"这个版本不可用"
    const unavailable = await service.getPack(caller(db, reader), first.packId, { releaseNumber: 2 }, db);
    expect(unavailable.requestedUnavailable).toBe(true);
    expect(unavailable.selected).toBeNull();

    // 作者仍能看自己撤回的内容（便于修正后发新版）
    const asAuthor = await service.getPack(caller(db, author), first.packId, { releaseNumber: 2 }, db);
    expect(asAuthor.selected?.title).toBe('第二版');
    expect(asAuthor.selected?.withdrawn).toBe(true);

    // 撤回后公开可见性由统一判据给出
    const visibility = await contentService.resolveVisibility(second.releaseId, db);
    expect(visibility.withdrawn).toBe(true);
    expect(visibility.publiclyVisible).toBe(false);
  });

  it('全部版本撤回后：退出广场，且不能再被收藏', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createPacksService({ db });
    const author = insertUser(db, { nickname: '作者' });
    const reader = insertUser(db, { nickname: '读者' });
    const plugins = seedPlugins(db, 1);

    const created = await service.createPackWithFirstRelease(caller(db, author), releaseInput(plugins), db);
    expect((await service.listPublicPacks({ page: 1, page_size: 20 }, db)).total).toBe(1);

    await service.withdrawRelease(caller(db, author), created.packId, created.releaseId, null, db);

    expect((await service.listPublicPacks({ page: 1, page_size: 20 }, db)).total).toBe(0);
    await expect(service.togglePackFavorite(caller(db, reader), created.packId, db)).rejects.toMatchObject({
      code: 'target_unavailable',
    });
  });

  it('校验：空清单 / 重复插件 / 非法安装目标 / 已实测缺任务 都被拒；非作者不能发版或撤回', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createPacksService({ db });
    const author = insertUser(db, { nickname: '作者' });
    const other = insertUser(db, { nickname: '路人' });
    const plugins = seedPlugins(db, 2);

    await expect(
      service.createPackWithFirstRelease(caller(db, author), { ...releaseInput(plugins), items: [] }, db),
    ).rejects.toMatchObject({ code: 'input_invalid' });

    await expect(
      service.createPackWithFirstRelease(
        caller(db, author),
        releaseInput([plugins[0]!, plugins[0]!]),
        db,
      ),
    ).rejects.toMatchObject({ code: 'input_invalid' });

    await expect(
      service.createPackWithFirstRelease(
        caller(db, author),
        releaseInput(plugins, {
          items: [
            {
              pluginId: plugins[0]!,
              pluginVersion: V_KNOWN('1.0.0'),
              // 包名含空格 → 规范化失败
              installTarget: { kind: 'npm', packageName: 'bad name', version: '1.0.0' } as InstallTarget,
            },
          ],
        }),
        db,
      ),
    ).rejects.toMatchObject({ code: 'input_invalid' });

    await expect(
      service.createPackWithFirstRelease(
        caller(db, author),
        releaseInput(plugins, { testStatus: 'tested', testTask: null, testResult: null }),
        db,
      ),
    ).rejects.toMatchObject({ code: 'input_invalid' });

    const created = await service.createPackWithFirstRelease(caller(db, author), releaseInput(plugins), db);
    await expect(
      service.addRelease(caller(db, other), created.packId, releaseInput(plugins), db),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      service.withdrawRelease(caller(db, other), created.packId, created.releaseId, '越权', db),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('收藏：切换、我收藏的整合包；版本未知不影响收藏', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createPacksService({ db });
    const author = insertUser(db, { nickname: '作者' });
    const reader = insertUser(db, { nickname: '读者' });
    const plugins = seedPlugins(db, 2);

    const created = await service.createPackWithFirstRelease(
      caller(db, author),
      releaseInput(plugins, { items: plugins.map((pluginId) => ({ pluginId, pluginVersion: V_UNKNOWN(), installTarget: null })) }),
      db,
    );

    expect(await service.togglePackFavorite(caller(db, reader), created.packId, db)).toEqual({ favorited: true });
    const favorites = await service.listFavoritePacks(caller(db, reader), {}, db);
    expect(favorites.items).toHaveLength(1);
    expect(favorites.items[0]!.packId).toBe(created.packId);
    expect(favorites.items[0]!.favoriteCount).toBe(1);

    expect(await service.togglePackFavorite(caller(db, reader), created.packId, db)).toEqual({ favorited: false });
    expect((await service.listFavoritePacks(caller(db, reader), {}, db)).items).toHaveLength(0);
  });
});

describe('安装命令适配器', () => {
  it('npm 与 GitHub 目标各生成一种命令；未知版本 / 无目标 → 待核实', () => {
    const bundle = buildInstallCommands([
      { pluginId: 'a', displayName: 'A', pluginVersion: V_KNOWN('0.9.6'), installTarget: NPM_TARGET },
      {
        pluginId: 'b',
        displayName: 'B',
        pluginVersion: V_KNOWN('1.0.0'),
        installTarget: GITHUB_TARGET,
      },
      { pluginId: 'c', displayName: 'C', pluginVersion: V_UNKNOWN(), installTarget: null },
      { pluginId: 'd', displayName: 'D', pluginVersion: V_UNKNOWN(), installTarget: NPM_TARGET },
    ]);

    expect(bundle.items[0]!.command).toBe('dsh plugin --profile <profile> add dsh-memory@0.9.6 --save-exact');
    expect(bundle.items[1]!.command).toBe(
      'dsh plugin --profile <profile> add github:RestRegular/dsh-memory#0123456789abcdef0123456789abcdef01234567 --save-exact',
    );
    expect(bundle.items[2]!.command).toBeNull();
    expect(bundle.items[3]!.command).toBeNull();
    expect(bundle.pendingCount).toBe(2);
    expect(bundle.copyAll.split('\n')).toHaveLength(2);
  });

  it('非法目标一律返回 null（不猜测）', () => {
    expect(normalizeInstallTarget({ kind: 'npm', packageName: 'UPPER', version: '1.0.0' })).toBeNull();
    expect(normalizeInstallTarget({ kind: 'github', repository: 'no-slash', commit: 'abc1234' })).toBeNull();
    expect(normalizeInstallTarget({ kind: 'github', repository: 'a/b', commit: 'zzz' })).toBeNull();
    expect(normalizeInstallTarget({ kind: 'gitlab', foo: 1 })).toBeNull();
    expect(normalizeInstallTarget(null)).toBeNull();
  });
});
