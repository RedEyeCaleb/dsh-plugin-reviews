'use client';

/** 整合包版本「有帮助」按钮。 */

import { useState } from 'react';
import { ApiError, ErrorNotice, apiFetch } from './api-client';

export function PackHelpfulButton({
  releaseId,
  initialCount,
  initialHelpful,
  authenticated,
}: {
  releaseId: string;
  initialCount: number;
  initialHelpful: boolean;
  authenticated: boolean;
}) {
  const [helpful, setHelpful] = useState(initialHelpful);
  const [count, setCount] = useState(initialCount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const toggle = async () => {
    if (!authenticated || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ helpful: boolean; count: number }>(
        `/api/pack-releases/${encodeURIComponent(releaseId)}/helpful`,
        { method: 'POST' },
      );
      setHelpful(result.helpful);
      setCount(result.count);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        className="button"
        onClick={() => void toggle()}
        disabled={busy || !authenticated}
        aria-pressed={helpful}
        title={authenticated ? '这个整合包有帮助' : '登录后可以投票'}
      >
        {helpful ? '已觉得有帮助' : '有帮助'}（{count}）
      </button>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </span>
  );
}
