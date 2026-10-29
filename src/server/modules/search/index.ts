/**
 * 评测全文检索（`idea.md §16`/§22）。
 *
 * 检索策略是**混合**的，原因写在迁移 0014 里：FTS5 的 trigram 分词只对 ≥3 字符的查询生效，
 * 而中文里两字词太常见（"记忆""检索"）。所以：
 *   * **≥3 字符** → `MATCH` + `bm25()` 相关度排序（真正的全文检索）；
 *   * **1–2 字符** → `LIKE '%q%'` 回退（子串匹配，按发布时间倒序）；
 *   * 空查询 → 全部公开评测，按发布时间倒序（与旧行为一致）。
 *
 * 两条路都必须回答同一个问题：**"只返回当前公开的评测"**。这里不复制可见性判据，
 * 统一调 `resolveVisibilityInTx`（撤回/隐藏/未发布，一处改全线生效）。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { withRead, withTransaction } from '@/server/platform/tx';
import { buildPage, type PageRequest, type PageResult } from '@/packages/common/result';
import { resolveVisibilityInTx } from '@/server/modules/content';
import { escapeLikePattern, UNCATEGORIZED_CATEGORY } from '@/server/modules/catalog/service';

export type SearchSource = 'all' | 'site' | 'community';

export interface ReviewSearchQuery extends PageRequest {
  q?: string;
  source?: SearchSource;
  /** 用途分类 slug（迁移 0010 的 `plugin_categories`）；`__none__` = 未命中任何分类。 */
  category?: string;
}

export interface ReviewSearchRow {
  review_id: string;
  title: string;
  source_kind: 'site' | 'community';
  public_updated_at: number;
  author_nickname: string;
  plugin_id: string | null;
  plugin_display_name: string | null;
  plugin_path: string | null;
  repo_full_name: string | null;
  /** 被测版本（原样 JSON 字符串，页面用既有的 formatVersionLabel 解析）。 */
  plugin_version: string;
  dsh_version: string;
  /** 封面展示图 URL（没有封面为 null；列表据此决定要不要放缩略图）。 */
  cover_url: string | null;
}

/** 候选上限：检索先取候选再逐行判可见性；500 足够覆盖"关键词命中"的常见规模。 */
const CANDIDATE_LIMIT = 500;

/**
 * bm25 的列权重：review_id（UNINDEXED，忽略）、title、body、plugin_name。
 * 标题 8、正文 1、插件名 4 —— 「按匹配程度」里，标题命中显然比正文里顺带提一句更相关。
 */
const BM25_WEIGHTS = 'bm25(review_search, 0.0, 8.0, 1.0, 4.0)';

/** 把用户输入变成一个安全的 FTS5 phrase 查询（内部双引号转义）。 */
function toFtsPhrase(input: string): string {
  return `"${input.replace(/"/g, '""')}"`;
}

/** 分类筛选的 SQL（与目录页同一口径：命中该分类认领的任一 topic）。 */
function categoryClause(slug: string): { sql: string; params: string[] } {
  if (slug === UNCATEGORIZED_CATEGORY) {
    return {
      sql: `NOT EXISTS (
              SELECT 1 FROM plugin_categories c, json_each(c.topics) ct
               WHERE c.is_visible = 1 AND ct.value IN (SELECT value FROM json_each(repo.topics))
            )`,
      params: [],
    };
  }
  return {
    sql: `EXISTS (
            SELECT 1 FROM plugin_categories c, json_each(c.topics) ct
             WHERE c.is_visible = 1 AND c.slug = ?
               AND ct.value IN (SELECT value FROM json_each(repo.topics))
          )`,
    params: [slug],
  };
}

/**
 * 把一篇评测（按它当前的**公开修订**）写进检索索引；没有公开修订则删掉旧索引行。
 *
 * 导出给 `workflows/publish-review` 在**同一个事务**里调用 —— 索引与"公开修订指针"
 * 必须一起成功或一起回滚，否则会出现"搜得到但打不开"或"发布了却搜不到"。
 */
export function reindexReviewInTx(conn: SqliteDatabase, reviewId: string): boolean {
  conn.prepare('DELETE FROM review_search WHERE review_id = ?').run(reviewId);
  const row = conn
    .prepare(
      `SELECT rev.title AS title, rev.body_markdown AS body,
              COALESCE(p.display_name, repo.full_name, '') AS plugin_name
         FROM reviews r
         JOIN review_revisions rev ON rev.id = r.published_revision_id
         LEFT JOIN plugins p ON p.id = r.plugin_id
         LEFT JOIN repositories repo ON repo.id = p.repository_id
        WHERE r.id = ?`,
    )
    .get(reviewId) as { title: string; body: string; plugin_name: string } | undefined;
  if (!row) return false;
  conn
    .prepare('INSERT INTO review_search (review_id, title, body, plugin_name) VALUES (?, ?, ?, ?)')
    .run(reviewId, row.title ?? '', row.body ?? '', row.plugin_name ?? '');
  return true;
}

export function createSearchService(deps: { db: SqliteDatabase }) {
  const { db } = deps;

  return {
    /** 发布流程内调用（同事务）。 */
    reindexReview(reviewId: string, injectedDb?: SqliteDatabase): void {
      if (injectedDb) {
        reindexReviewInTx(injectedDb, reviewId);
        return;
      }
      withTransaction((tx) => reindexReviewInTx(tx.db, reviewId), db);
    },

    /** 回填/重建（脚本用）：返回重建条数。 */
    async rebuildIndex(): Promise<number> {
      return withTransaction((tx) => {
        const conn = tx.db;
        conn.prepare('DELETE FROM review_search').run();
        const ids = conn
          .prepare('SELECT r.id AS id FROM reviews r WHERE r.published_revision_id IS NOT NULL')
          .all() as Array<{ id: string }>;
        let n = 0;
        for (const { id } of ids) if (reindexReviewInTx(conn, id)) n += 1;
        return n;
      }, db);
    },

    async searchReviews(query: ReviewSearchQuery): Promise<PageResult<ReviewSearchRow>> {
      const page = Number.isInteger(query.page) && query.page > 0 ? query.page : 1;
      const pageSize = Math.min(Math.max(query.page_size ?? 20, 1), 50);
      const q = (query.q ?? '').trim().slice(0, 100);
      const source: SearchSource = query.source ?? 'all';
      const category = (query.category ?? '').trim();

      // ---- 1) 取候选 id（顺序即相关度）----
      const candidateIds: string[] = await withRead((conn) => {
        if (q.length === 0) {
          const rows = conn
            .prepare(
              `SELECT r.id AS id FROM reviews r
                 JOIN content_entities ce ON ce.id = r.id
                WHERE r.published_revision_id IS NOT NULL
                ORDER BY ce.public_updated_at DESC, r.id ASC
                LIMIT ?`,
            )
            .all(CANDIDATE_LIMIT) as Array<{ id: string }>;
          return rows.map((r) => r.id);
        }

        if ([...q].length >= 3) {
          const rows = conn
            .prepare(
              `SELECT review_id AS id, ${BM25_WEIGHTS} AS score
                 FROM review_search
                WHERE review_search MATCH ?
                ORDER BY score ASC, review_id ASC
                LIMIT ?`,
            )
            .all(toFtsPhrase(q), CANDIDATE_LIMIT) as Array<{ id: string }>;
          return rows.map((r) => r.id);
        }

        // 1–2 字：走 LIKE 回退（子串）
        const like = `%${escapeLikePattern(q)}%`;
        const rows = conn
          .prepare(
            `SELECT r.id AS id FROM reviews r
               JOIN content_entities ce ON ce.id = r.id
               JOIN review_revisions rev ON rev.id = r.published_revision_id
               LEFT JOIN plugins p ON p.id = r.plugin_id
               LEFT JOIN repositories repo ON repo.id = p.repository_id
              WHERE r.published_revision_id IS NOT NULL
                AND (rev.title LIKE ? ESCAPE '\\'
                     OR rev.body_markdown LIKE ? ESCAPE '\\'
                     OR COALESCE(p.display_name, repo.full_name, '') LIKE ? ESCAPE '\\')
              ORDER BY ce.public_updated_at DESC, r.id ASC
              LIMIT ?`,
          )
          .all(like, like, like, CANDIDATE_LIMIT) as Array<{ id: string }>;
        return rows.map((r) => r.id);
      }, db);

      if (candidateIds.length === 0) {
        return buildPage<ReviewSearchRow>([], 0, { page, page_size: pageSize });
      }

      // ---- 2) 取展示字段 + 来源/分类筛选（SQL 层）----
      const cat = category.length > 0 ? categoryClause(category) : null;
      const rows: ReviewSearchRow[] = await withRead((conn) => {
        const result: ReviewSearchRow[] = [];
        // 分块查询：SQLite 的参数上限是 999，500 个 id 一次没问题，但分块更稳
        for (let i = 0; i < candidateIds.length; i += 200) {
          const chunk = candidateIds.slice(i, i + 200);
          const placeholders = chunk.map(() => '?').join(', ');
          const params: unknown[] = [...chunk];
          let where = `r.id IN (${placeholders}) AND r.published_revision_id IS NOT NULL`;
          if (source !== 'all') {
            where += ' AND r.source_kind = ?';
            params.push(source);
          }
          if (cat) {
            where += ` AND ${cat.sql}`;
            params.push(...cat.params);
          }
          const found = conn
            .prepare(
              `SELECT r.id AS review_id, rev.title, r.source_kind, ce.public_updated_at,
                      u.nickname AS author_nickname, r.plugin_id,
                      p.display_name AS plugin_display_name, p.plugin_path,
                      repo.full_name AS repo_full_name,
                      rev.plugin_version, rev.dsh_version,
                      -- 封面（本修订固定下来的 cover 引用，且文件已就绪）
                      (SELECT '/media/' || a.id || '/' || f.variant_key
                         FROM review_revision_attachment_links l
                         JOIN attachment_files f ON f.id = l.file_id
                         JOIN attachments a ON a.id = f.attachment_id
                        WHERE l.review_revision_id = rev.id AND l.usage = 'cover'
                          AND f.processing_state = 'ready' AND f.variant_role = 'display'
                        LIMIT 1) AS cover_url
                 FROM reviews r
                 JOIN content_entities ce ON ce.id = r.id
                 JOIN users u ON u.id = ce.author_id
                 JOIN review_revisions rev ON rev.id = r.published_revision_id
                 LEFT JOIN plugins p ON p.id = r.plugin_id
                 LEFT JOIN repositories repo ON repo.id = p.repository_id
                WHERE ${where}`,
            )
            .all(...params) as Array<{
            review_id: string;
            title: string;
            source_kind: 'site' | 'community';
            public_updated_at: number;
            author_nickname: string;
            plugin_id: string | null;
            plugin_display_name: string | null;
            plugin_path: string | null;
            repo_full_name: string | null;
            plugin_version: string;
            dsh_version: string;
            cover_url: string | null;
          }>;
          result.push(...found);
        }
        return result;
      }, db);

      // ---- 3) 按候选顺序排（相关度/时间），并逐行判可见性 ----
      const order = new Map(candidateIds.map((id, idx) => [id, idx]));
      const visible = rows
        .filter((row) => resolveVisibilityInTx(db, row.review_id).publiclyVisible)
        .sort((a, b) => (order.get(a.review_id) ?? 0) - (order.get(b.review_id) ?? 0));

      const total = visible.length;
      const start = (page - 1) * pageSize;
      return buildPage(visible.slice(start, start + pageSize), total, { page, page_size: pageSize });
    },
  };
}

export type SearchService = ReturnType<typeof createSearchService>;
