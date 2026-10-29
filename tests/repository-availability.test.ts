/**
 * 可达性轮次（规划 §5.3）：连续三轮不可访问才认定「暂不可访问」。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertRepository, type TestDb } from './support/db';
import { recordAvailabilityRound, UNAVAILABLE_ROUNDS_THRESHOLD } from '../src/server/modules/catalog';

let ctx: TestDb | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function read(db: TestDb['db'], id: string) {
  return db
    .prepare('SELECT availability_state, consecutive_unavailable FROM repositories WHERE id = ?')
    .get(id) as { availability_state: string; consecutive_unavailable: number };
}

describe('仓库可达性轮次', () => {
  it('单次失败不改变结论；累计到阈值才置 unavailable', () => {
    ctx = createTestDb();
    const db = ctx.db;
    const repo = insertRepository(db);
    const now = Date.now();

    // 收录时就是 available
    db.prepare("UPDATE repositories SET availability_state = 'available' WHERE id = ?").run(repo);

    for (let round = 1; round < UNAVAILABLE_ROUNDS_THRESHOLD; round += 1) {
      const out = recordAvailabilityRound(db, repo, { reachable: false, now: now + round });
      expect(out.consecutiveUnavailable).toBe(round);
      expect(out.state).toBe('available'); // 未到阈值：保持原结论
    }

    const third = recordAvailabilityRound(db, repo, { reachable: false, now: now + 100 });
    expect(third.consecutiveUnavailable).toBe(UNAVAILABLE_ROUNDS_THRESHOLD);
    expect(third.state).toBe('unavailable');
    expect(read(db, repo).availability_state).toBe('unavailable');
  });

  it('中途成功一次就清零：之前的失败计数不作数', () => {
    ctx = createTestDb();
    const db = ctx.db;
    const repo = insertRepository(db);
    const now = Date.now();

    recordAvailabilityRound(db, repo, { reachable: false, now });
    recordAvailabilityRound(db, repo, { reachable: false, now: now + 1 });
    expect(read(db, repo).consecutive_unavailable).toBe(2);

    const ok = recordAvailabilityRound(db, repo, { reachable: true, now: now + 2 });
    expect(ok.state).toBe('available');
    expect(read(db, repo).consecutive_unavailable).toBe(0);

    // 清零后要重新数三轮
    const after = recordAvailabilityRound(db, repo, { reachable: false, now: now + 3 });
    expect(after.consecutiveUnavailable).toBe(1);
    expect(read(db, repo).availability_state).toBe('available');
  });

  it('成功会记录最近成功时间；失败不写最近成功时间', () => {
    ctx = createTestDb();
    const db = ctx.db;
    const repo = insertRepository(db);
    const now = Date.now();

    recordAvailabilityRound(db, repo, { reachable: true, now });
    const afterOk = db
      .prepare('SELECT last_checked_at, last_successful_check_at FROM repositories WHERE id = ?')
      .get(repo) as { last_checked_at: number; last_successful_check_at: number };
    expect(afterOk.last_checked_at).toBe(now);
    expect(afterOk.last_successful_check_at).toBe(now);

    recordAvailabilityRound(db, repo, { reachable: false, now: now + 5000 });
    const afterFail = db
      .prepare('SELECT last_checked_at, last_successful_check_at FROM repositories WHERE id = ?')
      .get(repo) as { last_checked_at: number; last_successful_check_at: number };
    expect(afterFail.last_checked_at).toBe(now + 5000);
    expect(afterFail.last_successful_check_at).toBe(now); // 不覆盖上次成功时间
  });

  it('不存在的仓库明确报错，不静默成功', () => {
    ctx = createTestDb();
    const db = ctx.db;
    expect(() =>
      recordAvailabilityRound(db, '00000000-0000-7000-8000-000000000000', {
        reachable: true,
        now: Date.now(),
      }),
    ).toThrow();
  });
});
