'use client';

/**
 * 管理员：整合包复核申请队列（客户端组件）。
 *
 * 服务端已把待处理申诉查好传进来；这里只负责决定与回显结果。
 * 「改判」＝直接发布该版本；「维持」必须填理由（服务端也会校验）。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice } from './api-client';

export interface PendingAppeal {
  appealId: string;
  releaseId: string;
  packId: string;
  title: string;
  authorNickname: string;
  message: string;
  snapshotAutoCheck: string | null;
  snapshotNote: string | null;
  createdAtText: string;
}

const AUTO_LABEL: Record<string, string> = {
  pass: '自动检查通过',
  needs_info: '自动检查提示补充',
  manual: '转人工审核',
  verifying: '安装资料核验中',
};

export function AdminPackAppealsPanel({ items }: { items: PendingAppeal[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiError | null>(null);

  const act = async (appealId: string, decision: 'overturn' | 'uphold') => {
    setBusyId(appealId);
    setError(null);
    try {
      const response = await fetch(`/api/admin/pack-appeals/${encodeURIComponent(appealId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, note: notes[appealId] ?? '' }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: { message?: string } };
      if (!response.ok || !payload.ok) {
        throw { code: 'request_failed', message: payload.error?.message ?? '处理失败。' } as ApiError;
      }
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusyId(null);
    }
  };

  if (items.length === 0) {
    return (
      <p className="empty" style={{ marginBottom: 0 }}>
        当前没有待处理的复核申请。
      </p>
    );
  }

  return (
    <>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      <ul className="item-list">
        {items.map((item) => (
          <li key={item.appealId} className="item">
            <div className="item-body">
              <h3>{item.title}</h3>
              <div className="list-meta">
                <span>作者 {item.authorNickname}</span>
                <span>申诉于 {item.createdAtText}</span>
                <span>
                  当时判定：
                  {item.snapshotAutoCheck
                    ? (AUTO_LABEL[item.snapshotAutoCheck] ?? item.snapshotAutoCheck)
                    : '人工审核'}
                </span>
              </div>
              {item.snapshotNote ? (
                <p className="muted" style={{ margin: '4px 0' }}>
                  当时的退回原因：{item.snapshotNote}
                </p>
              ) : null}
              <p style={{ margin: '6px 0' }}>作者申辩：{item.message}</p>
              <input
                type="text"
                maxLength={200}
                placeholder="处理说明（维持原判时必填）"
                value={notes[item.appealId] ?? ''}
                onChange={(e) => setNotes((prev) => ({ ...prev, [item.appealId]: e.target.value }))}
                style={{ width: '100%', maxWidth: 480 }}
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="button primary"
                  disabled={busyId === item.appealId}
                  onClick={() => void act(item.appealId, 'overturn')}
                >
                  改判并发布
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busyId === item.appealId || (notes[item.appealId] ?? '').trim().length === 0}
                  onClick={() => void act(item.appealId, 'uphold')}
                >
                  维持原判
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
