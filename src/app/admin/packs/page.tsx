/** 管理员：整合包待审列表。 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '../../api/_lib/context';
import { isAdmin } from '@/server/platform/context';
import { PackReviewActions } from '@/components/pack-review-actions';
import { formatDateTimeOr } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

export default async function AdminPacksPage() {
  const ctx = await currentContext();
  if (!isAdmin(ctx)) redirect('/');

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT rel.id AS release_id, rel.pack_id, rel.title, rel.purpose, rel.submitted_at,
              u.nickname,
              (SELECT COUNT(*) FROM plugin_pack_release_items i WHERE i.release_id = rel.id) AS item_count,
              (SELECT file_name FROM plugin_pack_release_files f WHERE f.release_id = rel.id
                ORDER BY f.created_at DESC LIMIT 1) AS file_name
         FROM plugin_pack_releases rel
         JOIN plugin_packs p ON p.id = rel.pack_id
         JOIN users u ON u.id = p.author_id
        WHERE rel.review_status = 'pending'
        ORDER BY rel.submitted_at ASC, rel.id ASC`,
    )
    .all() as Array<{
    release_id: string;
    pack_id: string;
    title: string;
    purpose: string;
    submitted_at: number;
    nickname: string;
    item_count: number;
    target_count: number;
  }>;

  return (
    <div>
      <h1>整合包审核</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        待审核版本（{rows.length}）：通过后分配「第 N 版」并公开；拒绝后作者可修改后重新提交。
      </p>
      <section className="panel">
        {rows.length === 0 ? (
          <p className="empty" style={{ marginBottom: 0 }}>
            当前没有待审核的整合包。
          </p>
        ) : (
          <ul className="item-list">
            {rows.map((row) => (
              <li key={row.release_id} className="item">
                <div className="item-body">
                  <h3>{row.title}</h3>
                  <div className="list-meta">
                    <span>作者 {row.nickname}</span>
                    <span>{row.item_count} 个插件</span>
                    <span>
                      {Number(row.target_count) > 0
                        ? `${row.target_count} 项可自动核验安装`
                        : '无结构化安装目标（需人工核对）'}
                    </span>
                    <span>{formatDateTimeOr(row.submitted_at, '时间未知')}</span>
                  </div>
                  <p className="muted" style={{ margin: '4px 0' }}>{row.purpose}</p>
                  <div style={{ marginTop: 6 }}>
                    <PackReviewActions releaseId={row.release_id} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p style={{ marginTop: 12 }}>
        <Link href="/admin">← 返回管理后台</Link>
      </p>
    </div>
  );
}
