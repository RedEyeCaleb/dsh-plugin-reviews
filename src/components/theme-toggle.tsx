'use client';

/**
 * 深色模式开关（个人设置 · 外观）。
 *
 * 只做外观：把 `data-theme` 写到 <html> 并存 localStorage；布局脚本在首屏绘制前
 * 先读一次，避免刷新时闪白。默认跟随系统，用户拨动后以显式选择为准。
 */

import { useEffect, useState } from 'react';
import { applyTheme, readTheme, type Theme } from '@/packages/common/theme';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');

  const apply = (next: Theme) => {
    applyTheme(next);
    setTheme(next);
  };

  useEffect(() => {
    const current = readTheme();
    setTheme(current);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', current === 'dark' ? '#121810' : '#f6f8f1');
  }, []);

  const toggle = () => {
    apply(theme === 'dark' ? 'light' : 'dark');
  };

  return (
    <div className="theme-row">
      <div className="theme-row-text">
        <span className="theme-row-title">深色模式</span>
        <span className="theme-row-desc">夜间使用更柔和；只影响这台设备，不改任何功能。</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={theme === 'dark'}
        aria-label="深色模式"
        className="md-switch"
        onClick={toggle}
      >
        <span className="md-switch-thumb" aria-hidden="true" />
      </button>
    </div>
  );
}