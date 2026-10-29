'use client';

/**
 * 批量导入多篇 `.md`：每份文件建一篇草稿（标题取首个 `# 标题` 或文件名）。
 *
 * 为什么在前端逐个建而不是做一个批量接口：
 *   - 草稿创建本身是**幂等**的（requestKey 去重），逐个调用失败只影响那一篇，
 *     不需要为「部分成功」再设计一套事务语义；
 *   - 进度天然可见：一篇一篇地显示成功/失败，作者知道哪篇没进来。
 *
 * 不做的事（如实说明）：图床图片不自动搬到本站——`.md` 里的外链图片保持原样，
 * 读者看到的就是作者写的那张图；要换成站内附件请用编辑器里的「插入图片」。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch, newRequestKey } from './api-client';

interface CreatedDraft {
  draftId: string;
  reviewId: string;
  saveVersion: number;
}

interface ImportOutcome {
  filename: string;
  draftId: string | null;
  error: string | null;
}

/** 从正文里取标题：第一个 Markdown 一级/二级标题；没有就用文件名（去扩展名）。 */
function titleOf(filename: string, markdown: string): string {
  const match = markdown.match(/^#{1,2}\s+(.+)$/m);
  if (match) return match[1].trim().slice(0, 80);
  return filename.replace(/\.(md|markdown|txt)$/i, '').slice(0, 80);
}

/** 把正文拆成编辑器认的分段（与编辑器内 toBodySegments 同口径：空行分段）。 */
function toBodySegments(markdown: string): { key: string; markdown: string }[] {
  return markdown.split(/\n{2,}/).map((text, index) => ({ key: `p${index}`, markdown: text }));
}

export function BulkMarkdownImport({ pluginId = null }: { pluginId?: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<ImportOutcome[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const onFiles = async (files: FileList) => {
    setBusy(true);
    setError(null);
    setOutcomes(null);
    const results: ImportOutcome[] = [];
    try {
      for (const file of Array.from(files)) {
        try {
          if (!/\.(md|markdown|txt)$/i.test(file.name)) {
            throw new Error('只支持 .md / .markdown / .txt');
          }
          if (file.size > 512 * 1024) {
            throw new Error('文件超过 512KB');
          }
          const text = await file.text();
          if (text.trim().length === 0) throw new Error('文件是空的');

          // 1) 建草稿（幂等：每篇一个新 requestKey）
          const draft = await apiFetch<CreatedDraft>('/api/drafts', {
            method: 'POST',
            json: { requestKey: newRequestKey(), pluginId },
          });

          // 2) 立刻把标题与正文写进草稿（不写就等于建了一个空壳）
          await apiFetch('/api/drafts', {
            method: 'PUT',
            json: {
              draftId: draft.draftId,
              requestKey: newRequestKey(),
              expectedVersion: draft.saveVersion,
              title: titleOf(file.name, text),
              pluginId,
              pluginVersion: { kind: 'unknown' },
              dshVersion: { kind: 'unknown' },
              body: toBodySegments(text),
              verdict: null,
              evidenceRefs: [],
              assessmentLevel: null,
            },
          });

          results.push({ filename: file.name, draftId: draft.draftId, error: null });
        } catch (e) {
          results.push({
            filename: file.name,
            draftId: null,
            error: e instanceof Error ? e.message : '导入失败',
          });
        }
        setOutcomes([...results]);
      }
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const okCount = outcomes?.filter((o) => o.draftId !== null).length ?? 0;

  return (
    <div style={{ marginTop: 12 }}>
      <label className="button" style={{ display: 'inline-block', cursor: busy ? 'default' : 'pointer' }}>
        {busy ? '导入中…' : '批量导入 .md'}
        <input
          type="file"
          multiple
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          disabled={busy}
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) void onFiles(files);
            e.target.value = '';
          }}
        />
      </label>
      <span className="muted" style={{ fontSize: 13, marginLeft: 8 }}>
        每个文件生成一篇草稿（标题取首个 # 标题或文件名）；导入后仍需逐篇绑定插件再提交。
      </span>

      {outcomes !== null ? (
        <div className="panel" style={{ marginTop: 10 }}>
          <div className="list-meta">
            <span>
              共 {outcomes.length} 篇，成功 {okCount} 篇
              {outcomes.length - okCount > 0 ? `，失败 ${outcomes.length - okCount} 篇` : ''}
            </span>
          </div>
          <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 13 }}>
            {outcomes.map((o) => (
              <li key={o.filename}>
                {o.draftId ? (
                  <>
                    {o.filename} → 已建草稿{' '}
                    <a href={`/me/drafts/${o.draftId}`}>打开编辑</a>
                  </>
                ) : (
                  <span style={{ color: 'var(--danger)' }}>
                    {o.filename}：{o.error}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </div>
  );
}
