/**
 * 主题读写（客户端共享）：首屏脚本已把 `data-theme` 写到 <html>，
 * 这里只负责读取与切换，设置页与页头按钮共用同一份逻辑。
 */

export type Theme = 'light' | 'dark';

/** 从 <html data-theme> 读当前主题。 */
export function readTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** 应用主题：写 data-theme、更新 theme-color、记住 localStorage。 */
export function applyTheme(next: Theme): void {
  document.documentElement.dataset.theme = next;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', next === 'dark' ? '#121810' : '#f6f8f1');
  try {
    localStorage.setItem('dsh-theme', next);
  } catch {
    // 隐私模式下 localStorage 可能不可写：主题仍然即时生效，只是不记住。
  }
}
