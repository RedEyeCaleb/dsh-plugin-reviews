/**
 * 安装资料核验（异步）：npm 包/版本、GitHub 提交。
 *
 * 判定口径（使用者 2026-10-29 裁定）：
 *   * 全做：npm 包存在 + 版本存在；GitHub 仓库/提交存在；子路径失败只记录不阻塞；
 *   * 先按条目的 install_target 判来源，不做跨来源猜测；
 *   * 关键目标失败 → 提示补充；网络错误 → 保持待核验（转人工）。
 */

import type { InstallTarget } from '@/packages/common/pack-install';
import { getJson, type HttpResult } from '@/server/platform/http';

export interface VerifyOutcome {
  kind: 'npm' | 'github';
  state: 'ok' | 'failed' | 'pending';
  detail: string;
}

type FetchJson = (url: string, init?: { headers?: Record<string, string> }) => Promise<HttpResult>;

export async function verifyInstallTarget(
  target: InstallTarget,
  fetchJson: FetchJson = getJson,
): Promise<VerifyOutcome> {
  if (target.kind === 'npm') {
    const res = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(target.packageName)}`);
    if (res.status === 0) {
      return { kind: 'npm', state: 'pending', detail: `网络错误：${res.error ?? '无法访问 npm registry'}` };
    }
    if (!res.ok) {
      return { kind: 'npm', state: 'failed', detail: `npm registry 返回 ${res.status}，无法确认包存在` };
    }
    const versions = (res.body as { versions?: Record<string, unknown> } | null)?.versions;
    if (!versions || versions[target.version] === undefined) {
      return {
        kind: 'npm',
        state: 'failed',
        detail: `npm 包 ${target.packageName} 没有版本 ${target.version}`,
      };
    }
    return { kind: 'npm', state: 'ok', detail: `npm ${target.packageName}@${target.version} 存在` };
  }

  const commitRes = await fetchJson(
    `https://api.github.com/repos/${target.repository}/commits/${target.commit}`,
    { headers: { accept: 'application/vnd.github+json' } },
  );
  if (commitRes.status === 0) {
    return { kind: 'github', state: 'pending', detail: `网络错误：${commitRes.error ?? '无法访问 GitHub'}` };
  }
  if (!commitRes.ok) {
    return {
      kind: 'github',
      state: 'failed',
      detail: `GitHub 提交不存在或不可访问（${commitRes.status}）：${target.repository}#${target.commit}`,
    };
  }

  let subPathNote = '';
  if (target.pluginPath) {
    const pathRes = await fetchJson(
      `https://api.github.com/repos/${target.repository}/contents/${target.pluginPath}?ref=${target.commit}`,
      { headers: { accept: 'application/vnd.github+json' } },
    );
    if (pathRes.status === 0 || !pathRes.ok) {
      subPathNote = `（子路径 ${target.pluginPath} 未核验通过，不阻塞）`;
    }
  }
  return { kind: 'github', state: 'ok', detail: `GitHub 提交存在${subPathNote}` };
}
