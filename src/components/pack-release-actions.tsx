'use client';

/**
 * 我的整合包版本操作：
 *  - 未提交/被拒：编辑、提交审核、删除草稿；
 *  - 待审核：只读；
 *  - 已发布：撤回；
 *  - 已撤回：只读。
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice } from './api-client';

export function PackReleaseActions({
  releaseId,
  packId,
  reviewStatus,
  withdrawn,
}: {
  releaseId: string;
  packId: string;
  reviewStatus: 'draft' | 'pending' | 'published' | 'rejected';
  withdrawn: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const request = async (url: string, init: RequestInit): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, init);
      const payload = (await response.json()) as { ok?: boolean; error?: { message?: string } };
      if (!response.ok || !payload.ok) {
        throw { code: 'request_failed', message: payload.error?.message ?? '操作失败，请稍后重试。' } as ApiError;
      }
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (
      !window.confirm(
        '提交审核？通过自动检查会直接发布；资料不足会提示补充；有疑问会转人工。',
      )
    ) {
      return;
    }
    void request(`/api/pack-releases/${encodeURIComponent(releaseId)}/submit`, { method: 'POST' });
  };

  const remove = () => {
    if (!window.confirm('删除这份未发布的整合包草稿？')) return;
    void request(`/api/pack-releases/${encodeURIComponent(releaseId)}`, { method: 'DELETE' });
  };

  const withdraw = () => {
    if (!window.confirm('撤回这个已发布版本？撤回后读者看不到它，历史快照保留。')) return;
    void request(
      `/api/packs/${encodeURIComponent(packId)}/releases/${encodeURIComponent(releaseId)}/withdraw`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) },
    );
  };

  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      {reviewStatus === 'draft' || reviewStatus === 'rejected' ? (
        <>
          <Link href={`/me/packs/releases/${releaseId}/edit`}>编辑</Link>
          <button type="button" className="button" disabled={busy} onClick={submit}>
            {busy ? '处理中…' : '提交审核'}
          </button>
          <button type="button" className="link-btn" disabled={busy} onClick={remove} style={{ color: 'var(--md-sys-color-error, #b3261e)' }}>
            删除草稿
          </button>
        </>
      ) : null}
      {reviewStatus === 'published' && !withdrawn ? (
        <button type="button" className="button" disabled={busy} onClick={withdraw}>
          撤回版本
        </button>
      ) : null}
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </span>
  );
}
