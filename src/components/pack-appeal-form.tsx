'use client';

/**
 * 作者：对「被退回」的整合包版本申请复核。
 *
 * 只在可申诉的状态下由父组件渲染。提交成功后刷新页面，让上方显示的判定与申诉记录同步。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice } from './api-client';

export function PackAppealForm({ releaseId }: { releaseId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/pack-releases/${encodeURIComponent(releaseId)}/appeals`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message }),
        },
      );
      const payload = (await response.json()) as { ok?: boolean; error?: { message?: string } };
      if (!response.ok || !payload.ok) {
        throw { code: 'request_failed', message: payload.error?.message ?? '提交失败。' } as ApiError;
      }
      setOpen(false);
      setMessage('');
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="button" onClick={() => setOpen(true)}>
        申请复核
      </button>
    );
  }

  return (
    <div style={{ marginTop: 8 }}>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="为什么认为这次判定有误？（例如：安装包确实存在，是 npm 私有源；或说明文字已足够，规则误判）"
        style={{ width: '100%' }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <button
          type="button"
          className="button primary"
          disabled={busy || message.trim().length < 5}
          onClick={() => void submit()}
        >
          提交复核申请
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => setOpen(false)}>
          取消
        </button>
      </div>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </div>
  );
}
