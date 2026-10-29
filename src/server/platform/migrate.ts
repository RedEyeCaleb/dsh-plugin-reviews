/**
 * 带编号记录的 SQL 迁移执行器（已删除的设计稿《切片说明》 §迁移策略）。
 *
 * 为什么手写而不是跑 Drizzle-Kit 生成流水线：
 * 本切片需要延迟外键顺序、联合唯一、部分唯一索引、行内 CHECK 与盖楼触发器，
 * 这些是 Drizzle schema 表达不稳或生成器管不到的地方。**权威结构是 migrations/*.sql**。
 *
 * 版本记录表 schema_migrations 是本切片唯一不在业务文档中的表，仅记录已应用迁移。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqliteDatabase } from './db';
import { openDatabase, resolveDbPath } from './db';

export interface AppliedMigration {
  version: string;
  appliedAt: number;
}

function ensureRegistry(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
    );
  `);
}

/**
 * 迁移文件里声明"本文件自己管事务"的标记（文件头独立一行：`-- dsh:migration-transaction=off`）。
 *
 * 为什么需要这个逃生口：SQLite **改不了列上的 CHECK 约束**，只能"重建表"
 * （新建 → 拷数据 → 删旧 → 改名）。而重建一张被外键引用的表，必须先把 `foreign_keys` 关掉；
 * 偏偏 **`PRAGMA foreign_keys` 在事务里是空操作** —— 被 `db.transaction()` 包住就永远关不掉。
 * 所以这类迁移必须自己写：
 *
 *     PRAGMA foreign_keys = OFF;
 *     BEGIN;
 *     ... 重建 ...
 *     COMMIT;
 *     PRAGMA foreign_keys = ON;
 *
 * 并在文件头声明本标记；执行器就不替它开事务、也不再包一层。
 *
 * ⚠️ 用它的迁移**必须自己保证原子性**（自带 BEGIN/COMMIT）：执行器不再替你回滚，
 * 中途失败会留下半成品。目前只有 `0007_task_type_plugin_discovery.sql` 用它。
 */
const NO_TRANSACTION_MARKER = /^--\s*dsh:migration-transaction=off\s*$/m;

function listMigrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

export interface MigrateResult {
  databaseFile: string;
  applied: string[];
  alreadyApplied: string[];
  foreignKeyCheck: string[];
}

/**
 * 应用所有未执行迁移。
 * 每个迁移文件在**独立事务**内执行；失败即回滚该文件，已成功的不重跑。
 */
export function migrate(options: {
  db?: SqliteDatabase;
  file?: string;
  migrationsDir?: string;
  now?: number;
} = {}): MigrateResult {
  const file = options.file ?? resolveDbPath(process.env.DSH_REVIEW_DB_PATH);
  const dir = options.migrationsDir ?? join(process.cwd(), 'migrations');
  const db = options.db ?? openDatabase({ file });
  const now = options.now ?? Date.now();

  ensureRegistry(db);

  const done = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((r) => r.version),
  );

  const applied: string[] = [];
  const already: string[] = [];

  for (const name of listMigrationFiles(dir)) {
    if (done.has(name)) {
      already.push(name);
      continue;
    }
    const sql = readFileSync(join(dir, name), 'utf8');
    const record = () =>
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(name, now);

    if (NO_TRANSACTION_MARKER.test(sql)) {
      // 本文件自带 BEGIN/COMMIT 与 PRAGMA（见 NO_TRANSACTION_MARKER 注释）：
      // 再包一层事务会让它的 `PRAGMA foreign_keys=OFF` 失效。
      db.exec(sql);
      record();
    } else {
      db.transaction(() => {
        db.exec(sql);
        record();
      })();
    }
    applied.push(name);
  }

  const foreignKeyCheck = (db.pragma('foreign_key_check') as unknown[]).map((row) => JSON.stringify(row));

  return { databaseFile: file, applied, alreadyApplied: already, foreignKeyCheck };
}

/** 启动自检（依赖与 Linux 部署第 4 节）：能力不足时明确失败，不静默降级。 */
export interface SelfCheckResult {
  ok: boolean;
  sqliteVersion: string;
  foreignKeys: boolean;
  journalMode: string;
  schemaVersion: string | null;
  missingTables: string[];
  problems: string[];
}

/** 本切片要求存在的业务表（权威结构见 migrations/0001_baseline.sql）。 */
export const REQUIRED_TABLES = [
  'users',
  'external_identities',
  'user_sessions',
  'repositories',
  'plugins',
  'content_entities',
  'reviews',
  'review_revisions',
  'content_drafts',
  'draft_save_receipts',
  'content_submissions',
  'content_moderation_records',
  'comments',
  'comment_revisions',
  'background_tasks',
  'background_task_attempts',
  'operation_records',
  'configuration_revisions',
  'site_settings',
  // 0004：运行时心跳（健康检查与容器 HEALTHCHECK 的判据；不是业务表）
  'runtime_heartbeats',
  // 0006：请求频控的计数表（rate-limiter-flexible 的 SQLite store 用它；不是业务表）
  'rate_limiter_flexible',
  // 0008：站内通知（新评论通知内容作者、回复通知被回复人）
  'notifications',
  // 0010：用途分类（把 GitHub topics 映射成可维护的中文分类）
  'plugin_categories',
  // 0012：互动三件套（有帮助 / 收藏 / 举报 + 处理记录）
  'review_helpful_votes',
  'plugin_favorites',
  'reports',
  'report_handling_records',
  // 0014：评测全文检索（FTS5 虚表；sqlite_master 里同样是 table 类型）
  'review_search',
  // 0015：资料纠错（请求 / 处理记录 / 生效的字段覆盖）
  'plugin_correction_requests',
  'plugin_correction_handling_records',
  'plugin_field_overrides',
  // 0020：整合包（身份 / 版本快照 / 条目 / 附件 / 收藏）
  'plugin_packs',
  'plugin_pack_releases',
  'plugin_pack_release_items',
  'plugin_pack_release_files',
  'plugin_pack_favorites',
  // 0022：整合包测评（挂在版本上）
  'pack_reviews',
  'pack_review_revisions',
  // 0024：整合包版本的「有帮助」投票
  'pack_release_helpful_votes',
  // 0026：安装资料核验记录（架构 §36.2）
  'plugin_install_checks',
  // 0028：整合包版本的复核申诉
  'plugin_pack_appeals',
] as const;

export function selfCheck(db: SqliteDatabase): SelfCheckResult {
  const problems: string[] = [];

  const versionRow = db.prepare('SELECT sqlite_version() AS v').get() as { v: string } | undefined;
  const sqliteVersion = String(versionRow?.v ?? 'unknown');
  const foreignKeys = db.pragma('foreign_keys', { simple: true }) === 1;
  if (!foreignKeys) problems.push('foreign_keys 未启用');

  const journalMode = String(db.pragma('journal_mode', { simple: true }));

  const existing = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name),
  );
  const missingTables = REQUIRED_TABLES.filter((t) => !existing.has(t));
  if (missingTables.length > 0) problems.push(`缺少业务表：${missingTables.join(', ')}`);

  const hasRegistry = existing.has('schema_migrations');
  const schemaVersion = hasRegistry
    ? ((db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get() as { version: string } | undefined)
        ?.version ?? null)
    : null;
  if (!hasRegistry) problems.push('缺少 schema_migrations，尚未执行迁移');

  const fkIssues = db.pragma('foreign_key_check') as unknown[];
  if (fkIssues.length > 0) problems.push(`foreign_key_check 报出 ${fkIssues.length} 条不一致`);

  return {
    ok: problems.length === 0,
    sqliteVersion,
    foreignKeys,
    journalMode,
    schemaVersion,
    missingTables,
    problems,
  };
}
