'use client';

/**
 * 页头主题切换按钮：头像旁边的小太阳 / 小月亮。
 *
 * 亮色时显示太阳，暗色时显示月亮；点击立即切换并记住到 localStorage。
 * 与个人设置里的开关共用 `@/packages/common/theme` 的读写逻辑。
 */

import { useEffect, useState } from 'react';
import { applyTheme, readTheme, type Theme } from '@/packages/common/theme';

function SunIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="4" />
      <line x1="12" y1="20" x2="12" y2="22" />
      <line x1="4.2" y1="4.2" x2="5.6" y2="5.6" />
      <line x1="18.4" y1="18.4" x2="19.8" y2="19.8" />
      <line x1="2" y1="12" x2="4" y2="12" />
      <line x1="20" y1="12" x2="22" y2="12" />
      <line x1="4.2" y1="19.8" x2="5.6" y2="18.4" />
      <line x1="18.4" y1="5.6" x2="19.8" y2="4.2" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    setTheme(readTheme());
  }, []);

  const next: Theme = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      className="theme-switch"
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
      aria-label={theme === 'dark' ? '切换到亮色模式' : '切换到深色模式'}
      title={theme === 'dark' ? '切换到亮色模式' : '切换到深色模式'}
    >
      {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}
