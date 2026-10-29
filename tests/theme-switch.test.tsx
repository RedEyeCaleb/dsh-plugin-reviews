// @vitest-environment jsdom
/**
 * 页头主题按钮：小太阳/小月亮，点击切换 data-theme 并记住 localStorage。
 *
 * 鉴别方式：把 ThemeSwitch 的 applyTheme 去掉 → 点后 data-theme 不变，用例红。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeSwitch } from '../src/components/theme-switch';

beforeEach(() => {
  document.documentElement.dataset.theme = 'dark';
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('页头主题切换', () => {
  it('暗色时显示月亮，点击切到亮色并记住', async () => {
    render(<ThemeSwitch />);

    const button = await screen.findByRole('button', { name: '切换到亮色模式' });
    fireEvent.click(button);

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('dsh-theme')).toBe('light');
    expect(screen.getByRole('button', { name: '切换到深色模式' })).toBeTruthy();
  });

  it('由亮色再点回暗色', async () => {
    document.documentElement.dataset.theme = 'light';
    render(<ThemeSwitch />);

    fireEvent.click(await screen.findByRole('button', { name: '切换到深色模式' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('dsh-theme')).toBe('dark');
  });
});
