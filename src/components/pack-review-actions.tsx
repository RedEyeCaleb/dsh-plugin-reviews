'use client';

/** 管理员审核整合包版本：通过 / 拒绝（可填原因）。 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice } from './api-client';

export function PackReviewActions({ releaseId }: { releaseId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  const act = async (action: 'approve' | 'reject') => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/pack-releases/${encodeURIComponent(releaseId)}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, note: action === 'reject' ? note : null }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: { message?: string } };
      if (!response.ok || !payload.ok) {
        throw { code: 'request_failed', message: payload.error?.message ?? '操作失败。' } as ApiError;
      }
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <button type="button" className="button primary" disabled={busy} onClick={() => void act('approve')}>
        通过
      </button>
      <input
        type="text"
        value={note}
        maxLength={200}
        placeholder="拒绝原因（可选）"
        onChange={(e) => setNote(e.target.value)}
        style={{ width: 180 }}
      />
      <button type="button" className="button" disabled={busy} onClick={() => void act('reject')}>
        拒绝
      </button>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </span>
  );
}
