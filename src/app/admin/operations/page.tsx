/**
 * 后台：操作记录查询。
 *
 * `operation_records` 一直是「写了但没人看得见」的表——去重、审计留痕都在写，
 * 但站内没有任何入口能查。管理员要回答「这个插件是谁在什么时候收录/隐藏的、为什么」，
 * 只能上机开库。这个页面就是那个入口。
 *
 * 口径（写清避免误读）：
 *   - **只读**：这里不提供任何修改/删除动作，历史记录不可变；
 *   - 按动作类型筛选，分页浏览（默认最新在前）；
 *   - `changes` 是 JSON，按需展开看原文，不做智能解释；
 *   - 系统身份（同步任务等）没有具体操作人，显示为「系统」。
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '../../api/_lib/context';
import { isAdmin } from '@/server/platform/context';
import { formatDateTimeOr } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 30;

interface Row {
  id: string;
  action_type: string;
  actor_kind: 'user' | 'admin' | 'system';
  actor_nickname: string | null;
  target_type: string;
  target_id: string;
  reason: string;
  changes: string;
  created_at: number;
}

export default async function AdminOperationsPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; page?: string }>;
}) {
  const ctx = await currentContext();
  if (!isAdmin(ctx)) redirect('/');

  const params = await searchParams;
  const actionFilter = (params.action ?? '').trim();
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);

  const db = getDb();
  const where = actionFilter === '' ? '' : 'WHERE o.action_type = ?';
  const args: string[] = actionFilter === '' ? [] : [actionFilter];

  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS c FROM operation_records o ${where}`).get(...args) as { c: number }).c,
  );
  const rows = db
    .prepare(
      `SELECT o.id, o.action_type, o.actor_kind, o.target_type, o.target_id,
              o.reason, o.changes, o.created_at, u.nickname AS actor_nickname
         FROM operation_records o
         LEFT JOIN users u ON u.id = o.actor_user_id
         ${where}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...args, PAGE_SIZE, (page - 1) * PAGE_SIZE) as Row[];

  // 现有动作类型（供筛选器）：从库里现取，不硬编码——新动作上线后自动出现。
  const actionTypes = (
    db
      .prepare('SELECT action_type, COUNT(*) AS c FROM operation_records GROUP BY action_type ORDER BY c DESC')
      .all() as Array<{ action_type: string; c: number }>
  ).map((r) => ({ type: r.action_type, count: Number(r.c) }));

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const query = actionFilter === '' ? '' : `&action=${encodeURIComponent(actionFilter)}`;

  return (
    <div>
      <h1>操作记录</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        共 {total} 条{actionFilter === '' ? '' : `（动作：${actionFilter}）`}。只读历史，不提供修改入口。
      </p>

      <div className="filters" style={{ marginTop: 12 }}>
        <span className="group-label">动作</span>
        <Link href="/admin/operations" className={actionFilter === '' ? 'active' : ''}>
          全部
        </Link>
        {actionTypes.map((a) => (
          <Link
            key={a.type}
            href={`/admin/operations?action=${encodeURIComponent(a.type)}`}
            className={actionFilter === a.type ? 'active' : ''}
          >
            {a.type}（{a.count}）
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="empty">没有符合条件的操作记录。</p>
      ) : (
        <div className="panel">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
                <th style={{ padding: 8 }}>时间</th>
                <th style={{ padding: 8 }}>动作</th>
                <th style={{ padding: 8 }}>操作人</th>
                <th style={{ padding: 8 }}>对象</th>
                <th style={{ padding: 8 }}>原因</th>
                <th style={{ padding: 8 }}>变更</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--line)', verticalAlign: 'top' }}>
                  <td className="muted" style={{ padding: 8, whiteSpace: 'nowrap' }}>
                    {formatDateTimeOr(r.created_at, '时间未知')}
                  </td>
                  <td style={{ padding: 8 }}>
                    <code style={{ fontSize: 12 }}>{r.action_type}</code>
                  </td>
                  <td style={{ padding: 8 }}>
                    {r.actor_kind === 'system' ? (
                      <span className="muted">系统</span>
                    ) : (
                      <span>
                        {r.actor_nickname ?? r.actor_kind}
                        {r.actor_kind === 'admin' ? <span className="muted">（管理员）</span> : null}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: 8 }}>
                    <span className="muted" style={{ fontSize: 12 }}>{r.target_type}</span>
                    <br />
                    <code style={{ fontSize: 11 }}>{r.target_id.slice(0, 8)}…</code>
                  </td>
                  <td style={{ padding: 8, maxWidth: 240 }}>{r.reason}</td>
                  <td style={{ padding: 8, maxWidth: 320 }}>
                    <details>
                      <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                        查看原文
                      </summary>
                      <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11, margin: 0 }}>
                        {r.changes}
                      </pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="list-meta" style={{ marginTop: 12 }}>
            <span>第 {page} / {totalPages} 页</span>
            {page > 1 ? <Link href={`/admin/operations?page=${page - 1}${query}`}>上一页</Link> : null}
            {page < totalPages ? <Link href={`/admin/operations?page=${page + 1}${query}`}>下一页</Link> : null}
          </div>
        </div>
      )}

      <p style={{ marginTop: 12 }}>
        <Link href="/admin">← 返回管理后台</Link>
      </p>
    </div>
  );
}
