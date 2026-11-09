/**
 * 桌面首页「一屏不滚动」的三条不变量。
 *
 * 首页没有任何滚动容器，条目高度又是固定的，所以"一屏"是靠 CSS 分档实现的：
 * 屏高每降一档就少显示一条。这几条一旦被人删掉，页面会立刻重新出现滚动条——
 * 而这种回归在代码评审里几乎看不出来（要真的拉窗口才知道），所以用测试钉住。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

describe('桌面首页一屏', () => {
  it('五档分档都在：屏高降到阈值以下就少一条', () => {
    for (const [height, keep] of [
      ['1073', 8],
      ['997', 7],
      ['921', 6],
      ['845', 5],
      ['719', 4],
    ] as const) {
      const block = new RegExp(
        `max-height: ${height}px\\)\\s*\\{[^}]*:nth-child\\(n \\+ ${keep}\\)`,
        'm',
      );
      expect(css, `缺 max-height: ${height}px 这一档`).toMatch(block);
    }
  });

  it('窄屏（≤1140）单独一套阈值：分类 chip 折行会多占约 30px', () => {
    expect(css).toMatch(/max-width: 1140px\) and \(max-height: 1102px\)/);
    expect(css).toMatch(/max-width: 1140px\) and \(max-height: 1026px\)/);
  });

  it('矮窗口（≤840）收紧英雄区，但分类 chip 到面板仍留 22px', () => {
    expect(css).toMatch(/max-height: 840px\)[\s\S]{0,400}?\.home-title/);
    expect(css).toMatch(/max-height: 840px\)[\s\S]{0,400}?font-size: 46px/);
    expect(css).toMatch(/max-height: 840px\)[\s\S]{0,600}?padding-bottom: 22px/);
  });

  it('分类 chip 与下面两栏之间留 26px（主人反馈原来贴太近）', () => {
    expect(css).toMatch(/\.home-page \.home-hero \{[^}]*padding-bottom: 26px/);
  });

  it('面板纵向 flex + 按钮贴底：两栏等高时不出现半截按钮', () => {
    expect(css).toMatch(/\.home-page \.home-feed > \.panel \{[^}]*display: flex/);
    expect(css).toMatch(/\.home-page \.home-feed \.home-more \{[^}]*margin-top: auto/);
  });
});