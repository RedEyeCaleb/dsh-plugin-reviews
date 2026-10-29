'use client';

/**
 * 新建整合包（发布第 1 版）。
 *
 * 入口沿用「从收藏夹创建」（C 路线保留 PR #37 的入口）：先选收藏夹 → 勾选插件 →
 * 逐个填「版本 / 安装目标」→ 填组合说明 → 提交即发布第 1 版。
 *
 * **安装目标必须结构化**：只填包名+版本（npm），或仓库+完整提交（GitHub）；
 * 都不确定就选「待核实」——服务端不会为待核实项生成命令。
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ApiError, ErrorNotice, apiFetch, buttonStyle, inputStyle } from './api-client';

export interface FolderOption {
  folderId: string;
  name: string;
  plugins: Array<{ pluginId: string; label: string }>;
}

interface ItemState {
  pluginId: string;
  label: string;
  selected: boolean;
  purpose: string;
  version: string;
  targetKind: 'unknown' | 'npm' | 'github';
  npmName: string;
  npmVersion: string;
  ghRepo: string;
  ghCommit: string;
  ghPath: string;
}

function toItems(folder: FolderOption | undefined): ItemState[] {
  if (!folder) return [];
  return folder.plugins.map((p) => ({
    pluginId: p.pluginId,
    label: p.label,
    selected: true,
    purpose: '',
    version: '',
    targetKind: 'unknown',
    npmName: '',
    npmVersion: '',
    ghRepo: '',
    ghCommit: '',
    ghPath: '',
  }));
}

export function PackCreateForm({ folders }: { folders: FolderOption[] }) {
  const [folderId, setFolderId] = useState(folders[0]?.folderId ?? '');
  const [items, setItems] = useState<ItemState[]>(() => toItems(folders[0]));
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [body, setBody] = useState('');
  const [dshKnown, setDshKnown] = useState(true);
  const [dshVersion, setDshVersion] = useState('');
  const [configTemplate, setConfigTemplate] = useState('');
  const [tested, setTested] = useState(false);
  const [testTask, setTestTask] = useState('');
  const [testResult, setTestResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const chosen = useMemo(() => items.filter((i) => i.selected), [items]);

  const switchFolder = (nextId: string) => {
    setFolderId(nextId);
    setItems(toItems(folders.find((f) => f.folderId === nextId)));
  };

  const patchItem = (pluginId: string, patch: Partial<ItemState>) => {
    setItems((prev) => prev.map((i) => (i.pluginId === pluginId ? { ...i, ...patch } : i)));
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const payloadItems = chosen.map((item) => {
        const pluginVersion = item.version.trim().length > 0 ? { kind: 'known' as const, value: item.version.trim() } : { kind: 'unknown' as const };
        let installTarget: unknown = null;
        if (item.targetKind === 'npm') {
          installTarget = { kind: 'npm', packageName: item.npmName.trim(), version: item.npmVersion.trim() };
        } else if (item.targetKind === 'github') {
          installTarget = {
            kind: 'github',
            repository: item.ghRepo.trim(),
            commit: item.ghCommit.trim(),
            pluginPath: item.ghPath.trim() || '.',
          };
        }
        return {
          pluginId: item.pluginId,
          purpose: item.purpose.trim() || undefined,
          pluginVersion,
          installTarget,
        };
      });

      await apiFetch<{ packId: string; releaseId: string }>('/api/packs', {
        method: 'POST',
        json: {
          title,
          purpose,
          bodyMarkdown: body,
          dshVersion: dshKnown
            ? dshVersion.trim().length > 0
              ? { kind: 'known', value: dshVersion.trim() }
              : { kind: 'unknown' }
            : { kind: 'unknown' },
          configTemplate: configTemplate.trim() || null,
          testStatus: tested ? 'tested' : 'untested',
          testTask: tested ? testTask : null,
          testResult: tested ? testResult : null,
          items: payloadItems,
        },
      });
      // 创建的是草稿（未上传）：回个人中心，由作者上传文件后进入审核。
      window.location.href = '/me/packs';
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  if (folders.length === 0) {
    return (
      <p className="empty">
        你还没有收藏夹。先到<Link href="/plugins">插件目录</Link>收藏几个插件，再回来创建整合包。
      </p>
    );
  }

  return (
    <div>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}

      <section className="panel">
        <div className="section-head">
          <h2>基本信息</h2>
        </div>

        <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>名称（1–80 字）</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} style={{ ...inputStyle, width: '100%', marginBottom: 10 }} />

        <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>用途说明（1–2000 字）</label>
        <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} maxLength={2000} style={{ ...inputStyle, width: '100%', marginBottom: 10 }} />

        <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>组合使用说明（Markdown）</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} style={{ ...inputStyle, width: '100%', marginBottom: 10 }} />

        <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
          <input type="checkbox" checked={dshKnown} onChange={(e) => setDshKnown(e.target.checked)} /> 记录 DSH 版本
        </label>
        {dshKnown ? (
          <input
            value={dshVersion}
            onChange={(e) => setDshVersion(e.target.value)}
            placeholder="例如 1.2.0；留空表示未知"
            style={{ ...inputStyle, width: '100%', marginBottom: 10 }}
          />
        ) : null}

        <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>配置模板（可选）</label>
        <textarea
          value={configTemplate}
          onChange={(e) => setConfigTemplate(e.target.value)}
          rows={4}
          placeholder="只放占位符，不要写真实密钥"
          style={{ ...inputStyle, width: '100%', marginBottom: 10 }}
        />

        <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
          <input type="checkbox" checked={tested} onChange={(e) => setTested(e.target.checked)} /> 我实际运行并测试过这个组合
        </label>
        {tested ? (
          <>
            <input value={testTask} onChange={(e) => setTestTask(e.target.value)} placeholder="测试任务（必填）" style={{ ...inputStyle, width: '100%', marginBottom: 8 }} />
            <textarea value={testResult} onChange={(e) => setTestResult(e.target.value)} rows={2} placeholder="测试结果（必填）" style={{ ...inputStyle, width: '100%', marginBottom: 10 }} />
          </>
        ) : null}
      </section>

      <section className="panel">
        <div className="section-head">
          <h2>插件清单（{chosen.length}）</h2>
        </div>

        <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>从收藏夹加入</label>
        <select value={folderId} onChange={(e) => switchFolder(e.target.value)} style={{ ...inputStyle, marginBottom: 10 }}>
          {folders.map((f) => (
            <option key={f.folderId} value={f.folderId}>
              {f.name}（{f.plugins.length} 个）
            </option>
          ))}
        </select>

        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {items.map((item) => (
            <li key={item.pluginId} style={{ borderTop: '1px solid var(--md-sys-color-outline-variant, #DBE1EA)', padding: '10px 0' }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                <input
                  type="checkbox"
                  checked={item.selected}
                  onChange={(e) => patchItem(item.pluginId, { selected: e.target.checked })}
                />
                <strong>{item.label}</strong>
              </label>

              {item.selected ? (
                <div style={{ display: 'grid', gap: 8, marginTop: 8, marginLeft: 24 }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <input
                      value={item.version}
                      onChange={(e) => patchItem(item.pluginId, { version: e.target.value })}
                      placeholder="插件版本（留空 = 未知，不生成 npm 命令）"
                      style={{ ...inputStyle, flex: '1 1 240px' }}
                    />
                    <input
                      value={item.purpose}
                      onChange={(e) => patchItem(item.pluginId, { purpose: e.target.value })}
                      placeholder="它在组合里的作用（可选）"
                      style={{ ...inputStyle, flex: '1 1 240px' }}
                    />
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <select
                      value={item.targetKind}
                      onChange={(e) => patchItem(item.pluginId, { targetKind: e.target.value as ItemState['targetKind'] })}
                      style={{ ...inputStyle }}
                    >
                      <option value="unknown">安装目标：待核实</option>
                      <option value="npm">npm（包名 + 明确版本）</option>
                      <option value="github">GitHub（仓库 + 完整提交）</option>
                    </select>

                    {item.targetKind === 'npm' ? (
                      <>
                        <input value={item.npmName} onChange={(e) => patchItem(item.pluginId, { npmName: e.target.value })} placeholder="包名，如 dsh-memory" style={{ ...inputStyle, flex: '1 1 160px' }} />
                        <input value={item.npmVersion} onChange={(e) => patchItem(item.pluginId, { npmVersion: e.target.value })} placeholder="明确版本，如 0.9.6" style={{ ...inputStyle, flex: '0 1 140px' }} />
                      </>
                    ) : null}

                    {item.targetKind === 'github' ? (
                      <>
                        <input value={item.ghRepo} onChange={(e) => patchItem(item.pluginId, { ghRepo: e.target.value })} placeholder="owner/repo" style={{ ...inputStyle, flex: '1 1 160px' }} />
                        <input value={item.ghCommit} onChange={(e) => patchItem(item.pluginId, { ghCommit: e.target.value })} placeholder="完整提交 SHA" style={{ ...inputStyle, flex: '0 1 200px' }} />
                        <input value={item.ghPath} onChange={(e) => patchItem(item.pluginId, { ghPath: e.target.value })} placeholder="子目录（可选）" style={{ ...inputStyle, flex: '0 1 140px' }} />
                      </>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          disabled={busy || chosen.length === 0 || title.trim().length === 0 || purpose.trim().length === 0 || body.trim().length === 0}
          onClick={() => void submit()}
          style={buttonStyle}
        >
          {busy ? '发布中…' : '发布第 1 版'}
        </button>
        <span className="muted">发布后内容即冻结；改内容要再发新版本。</span>
      </div>
    </div>
  );
}
