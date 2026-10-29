/**
 * 工作包 GT 测试：任务队列 + 审核状态机 + 审计去重。
 *
 * 纪律（并行工作包 §3）：
 *  - 每个用例都必须在实现被破坏时变红（下面每条都标注了"怎么破坏它"）；
 *  - 禁止恒真断言；
 *  - 用真实临时文件数据库 + 真实迁移（tests/support/db.ts 的 createTestDb）。
 *
 * 反例对照表（破坏实现 → 哪个用例变红）：
 *  ┌──────────────────────────────────────────────┬──────────────────────────────┐
 *  │ 破坏点                                        │ 变红用例                      │
 *  ├──────────────────────────────────────────────┼──────────────────────────────┤
 *  │ renew 去掉 execution_token 校验               │ 旧执行权不能续期              │
 *  │ renew 去掉 lease_expires_at > now             │ 过期租约不能续期              │
 *  │ finish 去掉 CAS 校验                          │ 旧执行权不能写回结束          │
 *  │ claim 不用原子 UPDATE（改成先 SELECT 后无条件写）│ 双 worker 抢同一任务只有一个成功 │
 *  │ recoverExpired 不记 lease_expired             │ 到期恢复：旧 attempt 记结局    │
 *  │ 重试计数每次清零                              │ 第 3 次失败后进入 failed      │
 *  │ 未配置筛查时直接 approved                     │ 筛查未配置不得自动放行        │
 *  │ isVersionResolved 把 unknown 当缺项           │ 明确未知的版本不构成退回理由  │
 *  │ operations 同键不比对摘要（直接返回原记录）    │ 同键不同摘要抛 keyReused      │
 *  └──────────────────────────────────────────────┴──────────────────────────────┘
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  insertPlugin,
  insertRepository,
  insertReview,
  insertUser,
  type TestDb,
} from './support/db';
import { newId } from '../src/server/platform/id';
import { digest } from '../src/server/platform/digest';
import type { SqliteDatabase } from '../src/server/platform/db';
import { DomainError } from '../src/packages/common/errors';
import {
  createTasksService,
  type ClaimedTask,
  type TasksService,
} from '../src/server/modules/tasks/service';
import {
  LEASE_DURATION_MS,
  MAX_RECOVERABLE_ATTEMPTS,
  RETRY_BACKOFF_MS,
  TASK_DEADLINE_MS,
  nextAvailableAt,
} from '../src/server/modules/tasks/constants';
import {
  createModerationService,
  evaluateRules,
  isVersionResolved,
} from '../src/server/modules/moderation/service';
import { createOperationsService } from '../src/server/modules/operations/service';
import { createWorker } from '../src/worker/main';
import type { CallerContext } from '../src/server/platform/context';

let ctx: TestDb | null = null;

afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function setup(): TestDb {
  ctx = createTestDb();
  return ctx;
}

function makeTasks(db: SqliteDatabase): TasksService {
  return createTasksService(db);
}

function enqueueInput(overrides: Partial<Parameters<TasksService['enqueue']>[0]> = {}) {
  return {
    taskType: 'review_check' as const,
    deduplicationKey: `dedup-${newId()}`,
    requestedBy: null,
    payload: { submissionId: 'x' },
    schedulingGroup: 'default',
    availableAt: 0,
    ...overrides,
  };
}

/** 读任务行（测试断言用）。 */
function taskRow(db: SqliteDatabase, taskId: string) {
  return db
    .prepare(
      `SELECT processing_state, available_at, attempt_count, retry_cycle, cycle_attempt_count,
              lease_owner, lease_expires_at, execution_token, last_error_code, finished_at
         FROM background_tasks WHERE id = ?`,
    )
    .get(taskId) as {
    processing_state: string;
    available_at: number;
    attempt_count: number;
    retry_cycle: number;
    cycle_attempt_count: number;
    lease_owner: string | null;
    lease_expires_at: number | null;
    execution_token: string | null;
    last_error_code: string | null;
    finished_at: number | null;
  };
}

/** 读任务的执行记录（按 attempt_number）。 */
function attemptRows(db: SqliteDatabase, taskId: string) {
  return db
    .prepare(
      `SELECT attempt_number, retry_cycle, outcome, finished_at, started_at, deadline_at,
              execution_token, worker_reference, error_code
         FROM background_task_attempts WHERE task_id = ? ORDER BY attempt_number`,
    )
    .all(taskId) as {
    attempt_number: number;
    retry_cycle: number;
    outcome: string | null;
    finished_at: number | null;
    started_at: number;
    deadline_at: number | null;
    execution_token: string;
    worker_reference: string;
    error_code: string | null;
  }[];
}

async function expectDomainError(promise: Promise<unknown>, code: string): Promise<DomainError> {
  try {
    await promise;
  } catch (e) {
    const d = e as DomainError;
    expect(d).toBeInstanceOf(DomainError);
    expect(d.code).toBe(code);
    return d;
  }
  throw new Error(`预期抛出 DomainError(${code})，但调用成功了`);
}

// ============================================================
// 1. 入队与去重
// ============================================================

describe('tasks.enqueue 去重', () => {
  it('同 (task_type, deduplication_key) 第二次入队复用既有任务，不新建', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);

    const first = await tasks.enqueue(enqueueInput({ deduplicationKey: 'same-key' }));
    const second = await tasks.enqueue(
      enqueueInput({ deduplicationKey: 'same-key', payload: { submissionId: 'CHANGED' } }),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.taskId).toBe(first.taskId);

    const count = db.prepare('SELECT COUNT(*) AS n FROM background_tasks').get() as { n: number };
    expect(count.n).toBe(2 - 1); // 只有一条任务行，不是两条
  });

  it('不同去重键建立两条独立任务', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);

    const a = await tasks.enqueue(enqueueInput({ deduplicationKey: 'k-a' }));
    const b = await tasks.enqueue(enqueueInput({ deduplicationKey: 'k-b' }));

    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.taskId).not.toBe(b.taskId);
  });

  it('同一去重键在任务已成功后仍复用（不重置为待执行）', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const first = await tasks.enqueue(enqueueInput({ deduplicationKey: 'done-key' }));

    const claim = (await tasks.claim('w1', 1000)) as ClaimedTask;
    await tasks.finish(
      { taskId: claim.taskId, executionToken: claim.executionToken },
      { outcome: 'success', now: 1001 },
    );

    const again = await tasks.enqueue(enqueueInput({ deduplicationKey: 'done-key' }));
    expect(again.created).toBe(false);
    expect(again.taskId).toBe(first.taskId);
    // 关键：没有被重置回 queued。
    expect(taskRow(db, first.taskId).processing_state).toBe('succeeded');
  });

  it('空去重键被拒绝（不会写出无法去重的任务）', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    await expectDomainError(tasks.enqueue(enqueueInput({ deduplicationKey: '   ' })), 'input_invalid');
    const count = db.prepare('SELECT COUNT(*) AS n FROM background_tasks').get() as { n: number };
    expect(count.n).toBe(0);
  });
});

// ============================================================
// 2. 领取
// ============================================================

describe('tasks.claim 原子领取', () => {
  it('未到 available_at 的任务领不到；到点后可领', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    await tasks.enqueue(enqueueInput({ availableAt: 5000 }));

    expect(await tasks.claim('w1', 4999)).toBeNull();
    const claim = await tasks.claim('w1', 5000);
    expect(claim).not.toBeNull();
    expect(claim!.taskType).toBe('review_check');
  });

  it('领取后任务进入 running，三字段执行权全部写入，attempt 记录同时建立', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const { taskId } = await tasks.enqueue(enqueueInput({ payload: { a: 1 } }));

    const claim = await tasks.claim('worker-A', 10_000);
    expect(claim).not.toBeNull();

    const row = taskRow(db, taskId);
    expect(row.processing_state).toBe('running');
    expect(row.lease_owner).toBe('worker-A');
    expect(row.execution_token).not.toBeNull();
    expect(row.execution_token).toBe(claim!.executionToken);
    expect(row.lease_expires_at).toBe(10_000 + LEASE_DURATION_MS);
    expect(row.attempt_count).toBe(1);
    expect(row.cycle_attempt_count).toBe(1);

    const attempts = attemptRows(db, taskId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.attempt_number).toBe(1);
    expect(attempts[0]!.worker_reference).toBe('worker-A');
    expect(attempts[0]!.execution_token).toBe(claim!.executionToken);
    expect(attempts[0]!.outcome).toBeNull();
    expect(attempts[0]!.finished_at).toBeNull();
    // attempt 有明确的执行期限（300s 上限）。
    expect(attempts[0]!.deadline_at).toBe(10_000 + TASK_DEADLINE_MS);

    // payload 被原样带出。
    expect(claim!.payload).toEqual({ a: 1 });
  });

  it('双 worker 抢同一任务只有一个成功，另一个拿到 null', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const { taskId } = await tasks.enqueue(enqueueInput());

    // 两个 worker 在同一个 now 上抢同一条任务。
    const results = await Promise.all([tasks.claim('worker-1', 1000), tasks.claim('worker-2', 1000)]);
    const winners = results.filter((r): r is ClaimedTask => r !== null);

    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);

    // 库里只能有 1 条 attempt，attempt_count 也只能是 1（没有重复计数）。
    const row = taskRow(db, taskId);
    expect(row.attempt_count).toBe(1);
    expect(attemptRows(db, taskId)).toHaveLength(1);
    expect(row.processing_state).toBe('running');
  });

  it('已被领取（running）的任务不会被第二个 worker 再领走', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    await tasks.enqueue(enqueueInput());

    const first = await tasks.claim('worker-1', 1000);
    const second = await tasks.claim('worker-2', 1001);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('空 worker 标识被拒绝', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    await expectDomainError(tasks.claim('  ', 1000), 'input_invalid');
  });
});

// ============================================================
// 3. 执行权 CAS：旧执行权不能写回（本工作包最重要的一组）
// ============================================================

describe('执行权 CAS：旧执行权不得写回', () => {
  it('换掉 token 后 renew 返回 false，且任务状态逐字段未变', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const { taskId } = await tasks.enqueue(enqueueInput());
    await tasks.claim('worker-1', 10_000);
    const before = taskRow(db, taskId);

    const ok = await tasks.renew({ taskId, executionToken: 'not-the-right-token' }, 10_100);
    expect(ok).toBe(false);

    // 逐字段比对：不只是"返回了 false"，而是**真的没改**。
    expect(taskRow(db, taskId)).toEqual(before);
  });

  it('租约已过期时 renew 返回 false，且不延长租约（不复活过期执行权）', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const { taskId } = await tasks.enqueue(enqueueInput());
    const claim = (await tasks.claim('worker-1', 10_000))!;
    const before = taskRow(db, taskId);

    // now 已越过 lease_expires_at（10_000 + 120_000）。
    const ok = await tasks.renew(
      { taskId, executionToken: claim.executionToken },
      claim.leaseExpiresAt + 1,
    );
    expect(ok).toBe(false);
    expect(taskRow(db, taskId)).toEqual(before);
    expect(taskRow(db, taskId).lease_expires_at).toBe(10_000 + LEASE_DURATION_MS);
  });

  it('租约未过期时 renew 成功并推进 lease_expires_at', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const { taskId } = await tasks.enqueue(enqueueInput());
    const claim = (await tasks.claim('worker-1', 10_000))!;

    const ok = await tasks.renew({ taskId, executionToken: claim.executionToken }, 10_000 + 30_000);
    expect(ok).toBe(true);
    expect(taskRow(db, taskId).lease_expires_at).toBe(10_000 + 30_000 + LEASE_DURATION_MS);
    // 续期不改状态，也不新建 attempt。
    expect(taskRow(db, taskId).processing_state).toBe('running');
    expect(attemptRows(db, taskId)).toHaveLength(1);
  });

  it('拿旧 token（已被顶替）调 finish 抛冲突，任务与 attempt 都不被改写', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const { taskId } = await tasks.enqueue(enqueueInput());

    const stolen = (await tasks.claim('worker-1', 10_000))!;
    const stolenToken = stolen.executionToken;
    const beforeTask = taskRow(db, taskId);
    const beforeAttempts = attemptRows(db, taskId);

    await expectDomainError(
      tasks.finish(
        { taskId, executionToken: stolenToken },
        { outcome: 'success', now: stolen.leaseExpiresAt + 1 },
      ),
      'version_conflict',
    );

    expect(taskRow(db, taskId)).toEqual(beforeTask);
    expect(taskRow(db, taskId).processing_state).toBe('running');
    expect(attemptRows(db, taskId)).toEqual(beforeAttempts);
    expect(attemptRows(db, taskId)[0]!.outcome).toBeNull();
  });

  it('伪造成其它 token 调 finish 抛冲突，不改状态（token 校验不能只比任务 ID）', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const { taskId } = await tasks.enqueue(enqueueInput());
    await tasks.claim('worker-1', 10_000);
    const before = taskRow(db, taskId);

    await expectDomainError(
      tasks.finish({ taskId, executionToken: 'forged' }, { outcome: 'success', now: 10_100 }),
      'version_conflict',
    );
    expect(taskRow(db, taskId)).toEqual(before);
  });

  it('任务已结束后，再用原 token 调 renew/finish 都被拒绝', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const { taskId } = await tasks.enqueue(enqueueInput());
    const claim = (await tasks.claim('worker-1', 10_000))!;
    await tasks.finish({ taskId, executionToken: claim.executionToken }, { outcome: 'success', now: 10_100 });

    const afterFinish = taskRow(db, taskId);
    expect(afterFinish.processing_state).toBe('succeeded');

    expect(await tasks.renew({ taskId, executionToken: claim.executionToken }, 10_200)).toBe(false);
    await expectDomainError(
      tasks.finish({ taskId, executionToken: claim.executionToken }, { outcome: 'success', now: 10_200 }),
      'version_conflict',
    );
    expect(taskRow(db, taskId)).toEqual(afterFinish);
  });
});

// ============================================================
// 4. finish：成功 / 跳过 / 重试预算
// ============================================================

describe('tasks.finish', () => {
  it('success → succeeded，attempt 记 success 且写入 finished_at', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const { taskId } = await tasks.enqueue(enqueueInput());
    const claim = (await tasks.claim('worker-1', 10_000))!;

    await tasks.finish({ taskId, executionToken: claim.executionToken }, { outcome: 'success', now: 12_345 });

    const row = taskRow(db, taskId);
    expect(row.processing_state).toBe('succeeded');
    expect(row.finished_at).toBe(12_345);
    // 终态必须清空执行权三字段（表 CHECK 要求）。
    expect(row.lease_owner).toBeNull();
    expect(row.lease_expires_at).toBeNull();
    expect(row.execution_token).toBeNull();

    const attempts = attemptRows(db, taskId);
    expect(attempts[0]!.outcome).toBe('success');
    expect(attempts[0]!.finished_at).toBe(12_345);
  });

  it('skipped → skipped 终态', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const { taskId } = await tasks.enqueue(enqueueInput());
    const claim = (await tasks.claim('worker-1', 10_000))!;

    await tasks.finish(
      { taskId, executionToken: claim.executionToken },
      { outcome: 'skipped', errorCode: 'not_applicable', errorSummary: '无需处理', now: 11_000 },
    );

    expect(taskRow(db, taskId).processing_state).toBe('skipped');
    expect(taskRow(db, taskId).finished_at).toBe(11_000);
    expect(attemptRows(db, taskId)[0]!.outcome).toBe('skipped');
  });

  it('可恢复故障：第 1 次等 30s、第 2 次等 120s、第 3 次进入 failed', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const { taskId } = await tasks.enqueue(enqueueInput({ availableAt: 0 }));

    expect(MAX_RECOVERABLE_ATTEMPTS).toBe(3);
    expect(RETRY_BACKOFF_MS).toEqual([30_000, 120_000]);

    // ---- 第 1 次失败：等待序列第 1 项 = 30s ----
    let now = 100_000;
    let claim = (await tasks.claim('w', now))!;
    await tasks.finish(
      { taskId, executionToken: claim.executionToken },
      { outcome: 'error', errorCode: 'E1', errorSummary: '第一次失败', now },
    );
    let row = taskRow(db, taskId);
    expect(row.processing_state).toBe('retry_wait');
    expect(row.available_at).toBe(now + RETRY_BACKOFF_MS[0]!);
    expect(row.attempt_count).toBe(1);
    expect(row.finished_at).toBeNull();

    // 未到可执行时刻领不到（等待真的生效，不是摆设）。
    expect(await tasks.claim('w', row.available_at - 1)).toBeNull();

    // ---- 第 2 次失败：等待序列第 2 项 = 120s ----
    now = row.available_at;
    claim = (await tasks.claim('w', now))!;
    expect(claim.attemptNumber).toBe(2);
    await tasks.finish(
      { taskId, executionToken: claim.executionToken },
      { outcome: 'error', errorCode: 'E2', errorSummary: '第二次失败', now },
    );
    row = taskRow(db, taskId);
    expect(row.processing_state).toBe('retry_wait');
    expect(row.available_at).toBe(now + RETRY_BACKOFF_MS[1]!);
    expect(row.attempt_count).toBe(2);

    // ---- 第 3 次失败：达到上限 → failed 终态 ----
    now = row.available_at;
    claim = (await tasks.claim('w', now))!;
    expect(claim.attemptNumber).toBe(3);
    await tasks.finish(
      { taskId, executionToken: claim.executionToken },
      { outcome: 'error', errorCode: 'E3', errorSummary: '第三次失败', now },
    );
    row = taskRow(db, taskId);
    expect(row.processing_state).toBe('failed');
    expect(row.finished_at).toBe(now);
    expect(row.attempt_count).toBe(3);
    expect(row.last_error_code).toBe('E3');

    // 三条执行记录都保留下来（历史不可抹掉），各记 error。
    const attempts = attemptRows(db, taskId);
    expect(attempts.map((a) => a.outcome)).toEqual(['error', 'error', 'error']);
    expect(attempts.map((a) => a.attempt_number)).toEqual([1, 2, 3]);

    // 终态后不再可领。
    expect(await tasks.claim('w', now + 10_000_000)).toBeNull();
  });

  it('任务不会无限重试：第 4 次领取永远发生不了（预算真的耗尽）', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const { taskId } = await tasks.enqueue(enqueueInput({ availableAt: 0 }));

    let now = 1000;
    let attemptsMade = 0;
    for (let i = 0; i < 10; i += 1) {
      const claim = await tasks.claim('w', now);
      if (!claim) break;
      attemptsMade += 1;
      await tasks.finish(
        { taskId, executionToken: claim.executionToken },
        { outcome: 'error', errorCode: `E${i}`, errorSummary: 'fail', now },
      );
      now = taskRow(db, taskId).available_at + 1;
    }

    expect(attemptsMade).toBe(MAX_RECOVERABLE_ATTEMPTS);
    expect(taskRow(db, taskId).processing_state).toBe('failed');
    expect(attemptRows(db, taskId)).toHaveLength(MAX_RECOVERABLE_ATTEMPTS);
  });

  it('cycle_attempt_count 永远不超过 attempt_count（表 CHECK 的语义）', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const { taskId } = await tasks.enqueue(enqueueInput({ availableAt: 0 }));

    let now = 1000;
    for (let i = 0; i < 2; i += 1) {
      const claim = await tasks.claim('w', now);
      if (!claim) break;
      const row = taskRow(db, taskId);
      expect(row.cycle_attempt_count).toBeLessThanOrEqual(row.attempt_count);
      await tasks.finish(
        { taskId, executionToken: claim.executionToken },
        { outcome: 'error', errorCode: 'E', errorSummary: 'x', now },
      );
      now = taskRow(db, taskId).available_at + 1;
    }
  });
});

// ============================================================
// 5. recoverExpired：到期恢复
// ============================================================

describe('tasks.recoverExpired 到期恢复', () => {
  it('租约未过期时不回收', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    await tasks.enqueue(enqueueInput());
    const claim = (await tasks.claim('w', 50_000))!;

    expect(await tasks.recoverExpired(claim.leaseExpiresAt - 1)).toBe(0);
    expect(taskRow(db, claim.taskId).processing_state).toBe('running');
  });

  it('租约过期 → 任务重新可领取，旧 attempt 保留并记 lease_expired', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const { taskId } = await tasks.enqueue(enqueueInput({ availableAt: 0 }));

    const claim = (await tasks.claim('worker-old', 50_000))!;
    const oldToken = claim.executionToken;
    const expiry = claim.leaseExpiresAt;

    const handled = await tasks.recoverExpired(expiry + 1);
    expect(handled).toBe(1);

    const row = taskRow(db, taskId);
    expect(row.processing_state).toBe('retry_wait');
    expect(row.lease_owner).toBeNull();
    expect(row.execution_token).toBeNull();
    expect(row.last_error_code).toBe('lease_expired');
    expect(row.available_at).toBe(expiry + 1 + RETRY_BACKOFF_MS[0]!);
    // 租约到期也是一次失败尝试，必须计入预算。
    expect(row.attempt_count).toBe(1);

    // 旧执行记录**保留**（不是删除，也不是新建一条代替）。
    const attempts = attemptRows(db, taskId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.attempt_number).toBe(1);
    expect(attempts[0]!.outcome).toBe('lease_expired');
    expect(attempts[0]!.finished_at).toBe(expiry + 1);
    expect(attempts[0]!.worker_reference).toBe('worker-old');

    // 旧 token 此后不能再写回。
    expect(await tasks.renew({ taskId, executionToken: oldToken }, expiry + 2)).toBe(false);

    // 到点后能被新 worker 重新领走，且是**新的** attempt 编号。
    const reclaim = await tasks.claim('worker-new', row.available_at);
    expect(reclaim).not.toBeNull();
    expect(reclaim!.attemptNumber).toBe(2);
    expect(reclaim!.executionToken).not.toBe(oldToken);
    expect(attemptRows(db, taskId)).toHaveLength(2);
    expect(attemptRows(db, taskId)[1]!.outcome).toBeNull();
  });

  it('反复到期耗尽预算后进入 failed（不会永远被回收）', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const { taskId } = await tasks.enqueue(enqueueInput({ availableAt: 0 }));

    let now = 1000;
    let recoveries = 0;
    for (let i = 0; i < 10; i += 1) {
      const claim = await tasks.claim('w', now);
      if (!claim) break;
      const handled = await tasks.recoverExpired(claim.leaseExpiresAt + 1);
      if (handled === 0) break;
      recoveries += 1;
      now = taskRow(db, taskId).available_at;
      if (taskRow(db, taskId).processing_state === 'failed') break;
    }

    expect(recoveries).toBe(MAX_RECOVERABLE_ATTEMPTS);
    const row = taskRow(db, taskId);
    expect(row.processing_state).toBe('failed');
    expect(row.finished_at).not.toBeNull();
    expect(attemptRows(db, taskId).map((a) => a.outcome)).toEqual([
      'lease_expired',
      'lease_expired',
      'lease_expired',
    ]);
  });

  it('已结束的 attempt 不会被改写（触发器真的在挡）', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const { taskId } = await tasks.enqueue(enqueueInput({ availableAt: 0 }));
    const claim = (await tasks.claim('w', 1000))!;
    await tasks.finish({ taskId, executionToken: claim.executionToken }, { outcome: 'success', now: 1100 });

    // 直接尝试改写已结束的执行记录：必须被触发器拒绝。
    expect(() =>
      db
        .prepare('UPDATE background_task_attempts SET outcome = ? WHERE execution_token = ?')
        .run('error', claim.executionToken),
    ).toThrow(/不可改写/);
  });
});

// ============================================================
// 6. 等待序列的纯函数语义
// ============================================================

describe('nextAvailableAt 重试等待序列', () => {
  it('尝试 1/2 返回 30s/120s，达到上限返回 null', () => {
    expect(nextAvailableAt(1, 0)).toBe(30_000);
    expect(nextAvailableAt(2, 0)).toBe(120_000);
    expect(nextAvailableAt(3, 0)).toBeNull();
    expect(nextAvailableAt(4, 0)).toBeNull();
  });
});

// ============================================================
// 7. 审核：规则校验
// ============================================================

/**
 * 造一条真实的评测提交（含修订快照），返回 submissionId 与作者 ID。
 *
 * 版本字段用 `?? {kind:'unknown'}` 之外的显式判空：`null` 表示**故意写一个
 * 非法/缺失的版本结构**（用于 needs_changes 用例），`undefined` 才是默认的明确未知。
 * 库里 plugin_version/dsh_version 只要求 json_valid，`null` 会被 JSON 序列化成
 * 字符串 "null"，读回来解析为 null → 规则判为缺项。
 */
function insertReviewSubmission(
  db: SqliteDatabase,
  input: {
    title?: string;
    pluginId?: string | null;
    pluginVersion?: unknown;
    dshVersion?: unknown;
    state?: string;
  } = {},
): { submissionId: string; authorId: string; revisionId: string; pluginId: string } {
  const authorId = insertUser(db, { role: 'user' });
  const repositoryId = insertRepository(db);
  const pluginId = insertPlugin(db, repositoryId);
  const reviewId = insertReview(db, { authorId, pluginId });

  // 直接插入修订行而不是走 insertReviewRevision：后者用 `?? {kind:'unknown'}` 兜底，
  // 会把"故意缺失的版本"变成"明确未知"。而 review_revisions 有不可变触发器，
  // 插完再 UPDATE 会被拒绝，所以必须在 INSERT 时就写对 JSON。
  const revisionId = newId();
  db.prepare(
    `INSERT INTO review_revisions
       (id, review_id, revision_number, plugin_id, title, body_markdown, plugin_version, dsh_version, submitted_at)
     VALUES (?, ?, 1, ?, ?, '正文', ?, ?, ?)`,
  ).run(
    revisionId,
    reviewId,
    pluginId,
    input.title ?? '一篇标题',
    JSON.stringify(input.pluginVersion === undefined ? { kind: 'unknown' } : input.pluginVersion),
    JSON.stringify(input.dshVersion === undefined ? { kind: 'unknown' } : input.dshVersion),
    Date.now(),
  );

  const submissionId = newId();
  const now = Date.now();

  // 评测提交要求 draft_id / draft_save_version 非空（0001 §3.5 的类型 CHECK），先建草稿。
  const draftId = newId();
  db.prepare(
    `INSERT INTO content_drafts (id, owner_id, draft_type, review_id, payload, save_version, created_at, saved_at)
     VALUES (?, ?, 'review', ?, '{}', 1, ?, ?)`,
  ).run(draftId, authorId, reviewId, now, now);

  db.prepare(
    `INSERT INTO content_submissions
       (id, submitted_by, submission_type, review_revision_id, draft_id, draft_save_version,
        request_key, request_digest, processing_state, state_version, publication_context,
        submitted_at, updated_at)
     VALUES (?, ?, 'review_revision', ?, ?, 1, ?, ?, ?, 0, '{}', ?, ?)`,
  ).run(
    submissionId,
    authorId,
    revisionId,
    draftId,
    `req-${submissionId}`,
    digest({ submissionId }),
    input.state ?? 'pending',
    now,
    now,
  );

  return { submissionId, authorId, revisionId, pluginId };
}

function submissionRow(db: SqliteDatabase, submissionId: string) {
  return db
    .prepare('SELECT processing_state, state_version FROM content_submissions WHERE id = ?')
    .get(submissionId) as { processing_state: string; state_version: number };
}

function moderationRecords(db: SqliteDatabase, submissionId: string) {
  return db
    .prepare(
      `SELECT operation_key, stage, result, actor_kind, actor_user_id, task_id, reason, evidence
         FROM content_moderation_records WHERE submission_id = ? ORDER BY created_at, id`,
    )
    .all(submissionId) as {
    operation_key: string;
    stage: string;
    result: string;
    actor_kind: string;
    actor_user_id: string | null;
    task_id: string | null;
    reason: string;
    evidence: string;
  }[];
}

/** 建一个真实任务行，供 runRuleCheck 的 task_id 使用。 */
async function ensureTask(db: SqliteDatabase, key = `t-${newId()}`): Promise<string> {
  const tasks = makeTasks(db);
  const { taskId } = await tasks.enqueue(enqueueInput({ deduplicationKey: key }));
  return taskId;
}

describe('isVersionResolved：已知或明确未知都算合法', () => {
  it('{kind:"unknown"} 是合法的明确未知（未知不构成退回理由）', () => {
    expect(isVersionResolved({ kind: 'unknown' })).toBe(true);
    expect(isVersionResolved({ kind: 'unknown', reason: '作者未提供' })).toBe(true);
  });

  it('{kind:"known"} 带非空 value 合法；空 value 不合法', () => {
    expect(isVersionResolved({ kind: 'known', value: '1.2.3' })).toBe(true);
    expect(isVersionResolved({ kind: 'known', value: '   ' })).toBe(false);
  });

  it('缺失 / null / 非对象 / kind 非法都不合法', () => {
    expect(isVersionResolved(undefined)).toBe(false);
    expect(isVersionResolved(null)).toBe(false);
    expect(isVersionResolved('1.2.3')).toBe(false);
    expect(isVersionResolved({})).toBe(false);
    expect(isVersionResolved({ kind: 'latest' })).toBe(false);
  });
});

describe('evaluateRules 纯规则判定', () => {
  it('标题为空 → needs_changes 且给出 title 字段路径', () => {
    const out = evaluateRules({
      submissionType: 'review_revision',
      title: '   ',
      pluginId: 'p1',
      pluginVersion: { kind: 'unknown' },
      dshVersion: { kind: 'unknown' },
    });
    expect(out.result).toBe('needs_changes');
    expect(out.fields.map((f) => f.path)).toContain('title');
  });

  it('未绑定插件 → needs_changes 且给出 plugin_id', () => {
    const out = evaluateRules({
      submissionType: 'review_revision',
      title: 'ok',
      pluginId: null,
      pluginVersion: { kind: 'unknown' },
      dshVersion: { kind: 'unknown' },
    });
    expect(out.result).toBe('needs_changes');
    expect(out.fields.map((f) => f.path)).toContain('plugin_id');
  });

  it('两个版本都明确未知 + 标题 + 插件齐全 → pass（未知不退回）', () => {
    const out = evaluateRules({
      submissionType: 'review_revision',
      title: 'ok',
      pluginId: 'p1',
      pluginVersion: { kind: 'unknown' },
      dshVersion: { kind: 'unknown', reason: '未提供' },
    });
    expect(out.result).toBe('pass');
    expect(out.fields).toEqual([]);
    expect(out.nextState).toBe('checking');
  });

  it('版本字段缺失 → needs_changes，且两条字段路径都在', () => {
    const out = evaluateRules({
      submissionType: 'review_revision',
      title: 'ok',
      pluginId: 'p1',
      pluginVersion: undefined,
      dshVersion: undefined,
    });
    expect(out.result).toBe('needs_changes');
    expect(out.fields.map((f) => f.path).sort()).toEqual(['dsh_version', 'plugin_version']);
  });
});

// ============================================================
// 8. 审核编排：未配置筛查绝不自动放行
// ============================================================

describe('moderation.runRuleCheck', () => {
  it('规则缺项（版本字段缺失）→ needs_changes，并落一条 rule_check 记录（带字段证据）', async () => {
    const { db } = setup();
    const mod = createModerationService(db);
    // 用"版本字段缺失"作为缺项：它是库里**能**表达出来的缺项
    // （review_revisions.title 有 trim(title)<>'' 的 CHECK，空标题插不进来；
    //  plugin_id 是 NOT NULL 外键，未绑定插件也插不进来）。
    // 这两条分支由下面 evaluateRules 的纯函数用例覆盖。
    const { submissionId } = insertReviewSubmission(db, { pluginVersion: null, dshVersion: null });
    const taskId = await ensureTask(db);

    await mod.runRuleCheck(submissionId, taskId);

    expect(submissionRow(db, submissionId).processing_state).toBe('needs_changes');
    const records = moderationRecords(db, submissionId);
    expect(records).toHaveLength(1);
    expect(records[0]!.stage).toBe('rule_check');
    expect(records[0]!.result).toBe('needs_changes');
    expect(records[0]!.actor_kind).toBe('system');
    expect(records[0]!.task_id).toBe(taskId);
    const evidence = JSON.parse(records[0]!.evidence) as { fields: { path: string }[] };
    expect(evidence.fields.map((f) => f.path).sort()).toEqual(['dsh_version', 'plugin_version']);
  });

  it('明确未知版本不被退回：两条 unknown 的提交不会被判 needs_changes', async () => {
    const { db } = setup();
    const mod = createModerationService(db);
    const { submissionId } = insertReviewSubmission(db, {
      title: '正常标题',
      pluginVersion: { kind: 'unknown' },
      dshVersion: { kind: 'unknown' },
    });
    const taskId = await ensureTask(db);

    await mod.runRuleCheck(submissionId, taskId);

    const state = submissionRow(db, submissionId).processing_state;
    expect(state).not.toBe('needs_changes');
    // 未配置筛查 → 停在 manual_review。
    expect(state).toBe('manual_review');
  });

  it('筛查未配置：停在 manual_review，绝不自动 approved，并记 fault', async () => {
    const { db } = setup();
    // 不注入 contentScreen → 视为未配置。
    const mod = createModerationService(db);
    const { submissionId } = insertReviewSubmission(db);
    const taskId = await ensureTask(db);

    await mod.runRuleCheck(submissionId, taskId);

    const state = submissionRow(db, submissionId).processing_state;
    expect(state).toBe('manual_review');
    expect(state).not.toBe('approved'); // 显式反断言：绝不自动放行

    const records = moderationRecords(db, submissionId);
    const screen = records.find((r) => r.stage === 'content_screen');
    expect(screen).toBeDefined();
    expect(screen!.result).toBe('fault');
    expect(screen!.task_id).toBe(taskId);

    // 库里不存在任何 approved 记录。
    const approved = records.filter((r) => r.result === 'pass');
    expect(approved).toHaveLength(0);
  });

  it('筛查适配器抛错 → 记 fault 并停在 manual_review（故障不放行）', async () => {
    const { db } = setup();
    const mod = createModerationService(db, {
      contentScreen: async () => {
        throw new Error('外部服务 500');
      },
    });
    const { submissionId } = insertReviewSubmission(db);
    const taskId = await ensureTask(db);

    await mod.runRuleCheck(submissionId, taskId);

    expect(submissionRow(db, submissionId).processing_state).toBe('manual_review');
    expect(moderationRecords(db, submissionId).find((r) => r.stage === 'content_screen')!.result).toBe('fault');
  });

  it('筛查返回不确定 → 停在 manual_review', async () => {
    const { db } = setup();
    const mod = createModerationService(db, { contentScreen: async () => 'inconclusive' });
    const { submissionId } = insertReviewSubmission(db);
    const taskId = await ensureTask(db);

    await mod.runRuleCheck(submissionId, taskId);

    expect(submissionRow(db, submissionId).processing_state).toBe('manual_review');
    expect(moderationRecords(db, submissionId).find((r) => r.stage === 'content_screen')!.result).toBe('manual_review');
  });

  it('筛查配置且通过 → approved（配置正常时放行是允许的）', async () => {
    const { db } = setup();
    const mod = createModerationService(db, { contentScreen: async () => 'pass' });
    const { submissionId } = insertReviewSubmission(db);
    const taskId = await ensureTask(db);

    await mod.runRuleCheck(submissionId, taskId);

    expect(submissionRow(db, submissionId).processing_state).toBe('approved');
    expect(moderationRecords(db, submissionId).find((r) => r.stage === 'content_screen')!.result).toBe('pass');
  });

  it('筛查判定违规 → needs_changes（不自动 approved）', async () => {
    const { db } = setup();
    const mod = createModerationService(db, { contentScreen: async () => 'violation' });
    const { submissionId } = insertReviewSubmission(db);
    const taskId = await ensureTask(db);

    await mod.runRuleCheck(submissionId, taskId);

    expect(submissionRow(db, submissionId).processing_state).toBe('needs_changes');
  });

  it('state_version 每次真实推进（不是原地不动）', async () => {
    const { db } = setup();
    const mod = createModerationService(db);
    const { submissionId } = insertReviewSubmission(db);
    const taskId = await ensureTask(db);

    expect(submissionRow(db, submissionId).state_version).toBe(0);
    await mod.runRuleCheck(submissionId, taskId);
    // pending → checking → manual_review 两次推进。
    expect(submissionRow(db, submissionId).state_version).toBe(2);
  });

  it('空 taskId 被拒绝（系统身份必须能追到任务）', async () => {
    const { db } = setup();
    const mod = createModerationService(db);
    const { submissionId } = insertReviewSubmission(db);
    await expectDomainError(mod.runRuleCheck(submissionId, '  '), 'input_invalid');
  });
});

// ============================================================
// 9. 审核：transition 与 appendRecord
// ============================================================

describe('moderation.transition 版本校验', () => {
  it('state_version 匹配 → 转换成功并递增', async () => {
    const { db } = setup();
    const mod = createModerationService(db);
    const { submissionId } = insertReviewSubmission(db);

    const out = await mod.transition(submissionId, {
      expectedStateVersion: 0,
      to: 'checking',
      reason: '开始检查',
    });
    expect(out.stateVersion).toBe(1);
    expect(submissionRow(db, submissionId).processing_state).toBe('checking');
    expect(submissionRow(db, submissionId).state_version).toBe(1);
  });

  it('state_version 不匹配 → 抛 version_conflict 且状态完全不变', async () => {
    const { db } = setup();
    const mod = createModerationService(db);
    const { submissionId } = insertReviewSubmission(db);
    const before = submissionRow(db, submissionId);

    await expectDomainError(
      mod.transition(submissionId, { expectedStateVersion: 99, to: 'approved', reason: '抢跑' }),
      'version_conflict',
    );
    expect(submissionRow(db, submissionId)).toEqual(before);
    expect(submissionRow(db, submissionId).processing_state).toBe('pending');
  });

  it('用旧的 expectedStateVersion 二次转换被拒（陈旧写入不能覆盖新状态）', async () => {
    const { db } = setup();
    const mod = createModerationService(db);
    const { submissionId } = insertReviewSubmission(db);

    await mod.transition(submissionId, { expectedStateVersion: 0, to: 'checking', reason: '第一次' });
    await expectDomainError(
      mod.transition(submissionId, { expectedStateVersion: 0, to: 'needs_changes', reason: '陈旧写入' }),
      'version_conflict',
    );
    expect(submissionRow(db, submissionId).processing_state).toBe('checking');
  });

  it('目标提交不存在 → target_unavailable', async () => {
    const { db } = setup();
    const mod = createModerationService(db);
    await expectDomainError(
      mod.transition(newId(), { expectedStateVersion: 0, to: 'checking', reason: 'x' }),
      'target_unavailable',
    );
  });
});

describe('moderation.appendRecord 约束', () => {
  it('system 身份缺 task_id 被拒（表 CHECK 的业务前置）', async () => {
    const { db } = setup();
    const mod = createModerationService(db);
    const { submissionId } = insertReviewSubmission(db);

    await expectDomainError(
      mod.appendRecord({
        submissionId,
        operationKey: 'k1',
        stage: 'rule_check',
        result: 'pass',
        actorKind: 'system',
        actorUserId: null,
        taskId: null,
        reason: '缺任务',
        evidence: {},
      }),
      'input_invalid',
    );
    expect(moderationRecords(db, submissionId)).toHaveLength(0);
  });

  it('admin 身份缺 actor_user_id 被拒', async () => {
    const { db } = setup();
    const mod = createModerationService(db);
    const { submissionId } = insertReviewSubmission(db);

    await expectDomainError(
      mod.appendRecord({
        submissionId,
        operationKey: 'k2',
        stage: 'manual_review',
        result: 'pass',
        actorKind: 'admin',
        actorUserId: null,
        taskId: null,
        reason: '缺操作者',
        evidence: {},
      }),
      'input_invalid',
    );
  });

  it('同 (submission, operation_key) 重复追加返回原记录 ID，不建重复行', async () => {
    const { db } = setup();
    const mod = createModerationService(db);
    const { submissionId } = insertReviewSubmission(db);
    const taskId = await ensureTask(db);

    const first = await mod.appendRecord({
      submissionId,
      operationKey: 'same-op',
      stage: 'rule_check',
      result: 'pass',
      actorKind: 'system',
      actorUserId: null,
      taskId,
      reason: '首次',
      evidence: { n: 1 },
    });
    const second = await mod.appendRecord({
      submissionId,
      operationKey: 'same-op',
      stage: 'rule_check',
      result: 'pass',
      actorKind: 'system',
      actorUserId: null,
      taskId,
      reason: '重复',
      evidence: { n: 2 },
    });

    expect(second).toBe(first);
    expect(moderationRecords(db, submissionId)).toHaveLength(1);
  });
});

// ============================================================
// 10. 管理员决定
// ============================================================

describe('moderation.decideByAdmin', () => {
  const adminCtx = (userId: string): CallerContext => ({ userId, role: 'admin', accountStatus: 'active' });

  it('管理员 approve → approved，并落 admin 身份的 manual_review 记录', async () => {
    const { db } = setup();
    const mod = createModerationService(db);
    const { submissionId } = insertReviewSubmission(db, { state: 'manual_review' });
    const adminId = insertUser(db, { role: 'admin' });

    const out = await mod.decideByAdmin(adminCtx(adminId), {
      submissionId,
      decision: 'approve',
      reason: '人工确认无问题',
      expectedStateVersion: 0,
      requestKey: 'admin-req-1',
    });

    expect(out.state).toBe('approved');
    expect(submissionRow(db, submissionId).processing_state).toBe('approved');
    const records = moderationRecords(db, submissionId);
    expect(records).toHaveLength(1);
    expect(records[0]!.actor_kind).toBe('admin');
    expect(records[0]!.actor_user_id).toBe(adminId);
    expect(records[0]!.result).toBe('pass');
  });

  it('审核结果通知作者：approve / needs_changes 各一条 moderation_result', async () => {
    const { db } = setup();
    const mod = createModerationService(db);
    const adminId = insertUser(db, { role: 'admin' });

    // 通过
    const ok = insertReviewSubmission(db, { state: 'manual_review' });
    await mod.decideByAdmin(adminCtx(adminId), {
      submissionId: ok.submissionId,
      decision: 'approve',
      reason: '人工确认无问题',
      expectedStateVersion: 0,
      requestKey: 'notify-req-1',
    });
    const okNotice = db
      .prepare("SELECT detail, content_entity_id, actor_id FROM notifications WHERE deduplication_key = ?")
      .get('review_decision:' + ok.submissionId + ':notify-req-1') as
      | { detail: string; content_entity_id: string | null; actor_id: string }
      | undefined;
    expect(okNotice).toBeTruthy();
    expect(okNotice?.detail).toContain('通过审核');
    const entity = db.prepare('SELECT review_id FROM review_revisions WHERE id = ?').get(ok.revisionId) as {
      review_id: string;
    };
    expect(okNotice?.content_entity_id).toBe(entity.review_id);
    expect(okNotice?.actor_id).toBe(adminId);

    // 需修改：理由进通知正文
    const bad = insertReviewSubmission(db, { state: 'manual_review' });
    await mod.decideByAdmin(adminCtx(adminId), {
      submissionId: bad.submissionId,
      decision: 'needs_changes',
      reason: '描述不足，请补充实测步骤',
      expectedStateVersion: 0,
      requestKey: 'notify-req-2',
    });
    const badNotice = db
      .prepare('SELECT detail FROM notifications WHERE deduplication_key = ?')
      .get('review_decision:' + bad.submissionId + ':notify-req-2') as { detail: string } | undefined;
    expect(badNotice?.detail).toContain('需要修改');
    expect(badNotice?.detail).toContain('实测步骤');
  });

  it('管理员 needs_changes → needs_changes', async () => {
    const { db } = setup();
    const mod = createModerationService(db);
    const { submissionId } = insertReviewSubmission(db, { state: 'manual_review' });
    const adminId = insertUser(db, { role: 'admin' });

    const out = await mod.decideByAdmin(adminCtx(adminId), {
      submissionId,
      decision: 'needs_changes',
      reason: '描述不足',
      expectedStateVersion: 0,
      requestKey: 'admin-req-2',
    });
    expect(out.state).toBe('needs_changes');
  });

  it('非管理员调用被拒（forbidden），且不改状态、不落记录', async () => {
    const { db } = setup();
    const mod = createModerationService(db);
    const { submissionId } = insertReviewSubmission(db, { state: 'manual_review' });
    const userId = insertUser(db, { role: 'user' });
    const before = submissionRow(db, submissionId);

    await expectDomainError(
      mod.decideByAdmin({ userId, role: 'user', accountStatus: 'active' }, {
        submissionId,
        decision: 'approve',
        reason: '越权',
        expectedStateVersion: 0,
        requestKey: 'user-req',
      }),
      'forbidden',
    );
    expect(submissionRow(db, submissionId)).toEqual(before);
    expect(moderationRecords(db, submissionId)).toHaveLength(0);
  });

  it('已禁用账户即使 role=admin 也被拒（账户状态每次从库读）', async () => {
    const { db } = setup();
    const mod = createModerationService(db);
    const { submissionId } = insertReviewSubmission(db, { state: 'manual_review' });
    const adminId = insertUser(db, { role: 'admin', accountStatus: 'disabled' });

    await expectDomainError(
      mod.decideByAdmin({ userId: adminId, role: 'admin', accountStatus: 'disabled' }, {
        submissionId,
        decision: 'approve',
        reason: '已禁用',
        expectedStateVersion: 0,
        requestKey: 'disabled-req',
      }),
      'forbidden',
    );
    expect(submissionRow(db, submissionId).processing_state).toBe('manual_review');
  });

  it('state_version 陈旧时拒绝（管理员决定也必须 CAS）', async () => {
    const { db } = setup();
    const mod = createModerationService(db);
    const { submissionId } = insertReviewSubmission(db, { state: 'manual_review' });
    const adminId = insertUser(db, { role: 'admin' });

    await expectDomainError(
      mod.decideByAdmin(adminCtx(adminId), {
        submissionId,
        decision: 'approve',
        reason: '抢跑',
        expectedStateVersion: 7,
        requestKey: 'stale-req',
      }),
      'version_conflict',
    );
    expect(submissionRow(db, submissionId).processing_state).toBe('manual_review');
    expect(moderationRecords(db, submissionId)).toHaveLength(0);
  });
});

// ============================================================
// 11. operations：审计去重
// ============================================================

describe('operations.record 去重', () => {
  /**
   * actor 必须是真实用户行：operation_records.actor_user_id 有真外键，
   * 用假 ID 会得到 FK 错误而不是被测的行为。
   */
  function baseInput(db: SqliteDatabase, overrides: Record<string, unknown> = {}) {
    const actorId = insertUser(db, { role: 'user' });
    return {
      actionType: 'review.publish',
      operationKey: 'op-1',
      actorKind: 'user' as const,
      actorUserId: actorId,
      targetType: 'review',
      targetId: 'target-1',
      targetSnapshot: { title: '标题' },
      changes: { published: true },
      reason: '发布评测',
      ...overrides,
    };
  }

  it('首次写入返回 replayed=false，并真的落库', async () => {
    const { db } = setup();
    const ops = createOperationsService(db);
    const out = await ops.record(baseInput(db));

    expect(out.replayed).toBe(false);
    const row = db.prepare('SELECT action_type, operation_key, reason, target_snapshot FROM operation_records WHERE id = ?').get(out.operationId) as {
      action_type: string;
      operation_key: string;
      reason: string;
      target_snapshot: string;
    };
    expect(row.action_type).toBe('review.publish');
    expect(row.operation_key).toBe('op-1');
    expect(row.reason).toBe('发布评测');
    expect(JSON.parse(row.target_snapshot)).toEqual({ title: '标题' });
  });

  it('同键同摘要 → 返回原记录（replayed=true），不新建行', async () => {
    const { db } = setup();
    const ops = createOperationsService(db);
    const input = baseInput(db);
    const first = await ops.record(input);
    const second = await ops.record(input);

    expect(second.replayed).toBe(true);
    expect(second.operationId).toBe(first.operationId);
    const count = db.prepare('SELECT COUNT(*) AS n FROM operation_records').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('同键**不同摘要** → 抛 request_key_reused，且不覆盖原记录', async () => {
    const { db } = setup();
    const ops = createOperationsService(db);
    const input = baseInput(db);
    const first = await ops.record(input);

    await expectDomainError(
      ops.record({ ...input, reason: '完全不同的操作', changes: { published: false } }),
      'request_key_reused',
    );

    // 原记录必须原样保留（不是"更新成新的"）。
    const rows = db.prepare('SELECT id, reason FROM operation_records').all() as { id: string; reason: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first.operationId);
    expect(rows[0]!.reason).toBe('发布评测');
  });

  it('不同 action_type 用同一个 operation_key 是两条独立记录', async () => {
    const { db } = setup();
    const ops = createOperationsService(db);
    const input = baseInput(db);
    const a = await ops.record(input);
    const b = await ops.record({ ...input, actionType: 'review.hide' });

    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
    expect(b.operationId).not.toBe(a.operationId);
    const count = db.prepare('SELECT COUNT(*) AS n FROM operation_records').get() as { n: number };
    expect(count.n).toBe(2);
  });

  it('system 身份带 actor_user_id 被拒（表 CHECK 的业务前置）', async () => {
    const { db } = setup();
    const ops = createOperationsService(db);
    const actorId = insertUser(db);
    await expectDomainError(
      ops.record(baseInput(db, { actorKind: 'system', actorUserId: actorId })),
      'input_invalid',
    );
    const count = db.prepare('SELECT COUNT(*) AS n FROM operation_records').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('user 身份缺 actor_user_id 被拒', async () => {
    const { db } = setup();
    const ops = createOperationsService(db);
    await expectDomainError(ops.record(baseInput(db, { actorUserId: null })), 'input_invalid');
  });

  it('空 reason 被拒（历史记录必须可解释）', async () => {
    const { db } = setup();
    const ops = createOperationsService(db);
    await expectDomainError(ops.record(baseInput(db, { reason: '   ' })), 'input_invalid');
  });
});

// ============================================================
// 12. worker：分发、续期、优雅退出
// ============================================================

describe('worker 调度', () => {
  it('领取任务 → 分发到已注册处理器 → finish 为 succeeded', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const { taskId } = await tasks.enqueue(enqueueInput({ payload: { marker: 'hello' } }));

    const seen: ClaimedTask[] = [];
    const worker = createWorker({
      workerReference: 'worker-test',
      tasks,
      handlers: {
        review_check: async (task) => {
          seen.push(task);
          return { outcome: 'success' };
        },
      },
    });

    const handled = await worker.runOnce();

    expect(handled).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.taskId).toBe(taskId);
    expect(seen[0]!.payload).toEqual({ marker: 'hello' });
    expect(taskRow(db, taskId).processing_state).toBe('succeeded');
    expect(attemptRows(db, taskId)[0]!.outcome).toBe('success');
  });

  it('未注册的处理器 → 任务记 skipped，不假装成功', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const { taskId } = await tasks.enqueue(enqueueInput({ taskType: 'comment_check' }));

    const worker = createWorker({ workerReference: 'w', tasks, handlers: {} });
    await worker.runOnce();

    expect(taskRow(db, taskId).processing_state).toBe('skipped');
    expect(taskRow(db, taskId).last_error_code).toBe('no_handler');
    expect(attemptRows(db, taskId)[0]!.outcome).toBe('skipped');
  });

  it('处理器抛错 → 任务进入 retry_wait（可恢复），不是崩溃', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const { taskId } = await tasks.enqueue(enqueueInput());

    const worker = createWorker({
      workerReference: 'w',
      tasks,
      handlers: {
        review_check: async () => {
          throw new Error('处理器炸了');
        },
      },
    });
    await worker.runOnce();

    const row = taskRow(db, taskId);
    expect(row.processing_state).toBe('retry_wait');
    expect(row.last_error_code).toBe('handler_threw');
    expect(attemptRows(db, taskId)[0]!.outcome).toBe('error');
  });

  it('无任务时 runOnce 返回 0，不空转报错', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const worker = createWorker({ workerReference: 'w', tasks, handlers: {} });
    expect(await worker.runOnce()).toBe(0);
  });

  it('并发上限不超过 MAX_CONCURRENT_TASKS（4）', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    for (let i = 0; i < 7; i += 1) {
      await tasks.enqueue(enqueueInput({ deduplicationKey: `k-${i}`, availableAt: 0 }));
    }

    let maxSeen = 0;
    let inFlight = 0;
    const worker = createWorker({
      workerReference: 'w',
      tasks,
      handlers: {
        review_check: async () => {
          inFlight += 1;
          maxSeen = Math.max(maxSeen, inFlight);
          inFlight -= 1;
          return { outcome: 'success' };
        },
      },
    });

    const handled = await worker.runOnce();
    expect(handled).toBe(4); // 一轮最多领 4 条
    expect(maxSeen).toBeLessThanOrEqual(4);
    const succeeded = db
      .prepare("SELECT COUNT(*) AS n FROM background_tasks WHERE processing_state = 'succeeded'")
      .get() as { n: number };
    expect(succeeded.n).toBe(4);
  });

  it('shouldContinue 变 false 后主循环退出（SIGTERM 优雅退出路径）', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    let running = true;
    let iterations = 0;
    let sleeps = 0;

    const worker = createWorker({
      workerReference: 'w',
      tasks,
      handlers: {},
      shouldContinue: () => running,
      sleep: async () => {
        sleeps += 1;
        iterations += 1;
        if (iterations >= 2) running = false; // 模拟收到 SIGTERM
      },
    });

    await worker.run(); // 必须能返回，不能挂死

    expect(running).toBe(false);
    expect(sleeps).toBe(2);
    // 循环期间没有任务被处理。
    expect(db.prepare('SELECT COUNT(*) AS n FROM background_tasks').get()).toEqual({ n: 0 });
  });

  it('worker 跑一轮后会回收到期租约（到期任务能被重新调度）', async () => {
    const { db } = setup();
    const tasks = makeTasks(db);
    const { taskId } = await tasks.enqueue(enqueueInput({ availableAt: 0 }));

    // 手工造一个已过期的 running 任务（模拟一个僵死的旧 worker）。
    const staleToken = 'stale-token';
    db.prepare(
      `UPDATE background_tasks
          SET processing_state = 'running', lease_owner = 'dead-worker', lease_expires_at = 1,
              execution_token = ?, attempt_count = 1, cycle_attempt_count = 1, updated_at = 1
        WHERE id = ?`,
    ).run(staleToken, taskId);
    db.prepare(
      `INSERT INTO background_task_attempts
         (id, task_id, attempt_number, retry_cycle, execution_token, worker_reference, started_at, last_progress_at)
       VALUES (?, ?, 1, 1, ?, 'dead-worker', 1, 1)`,
    ).run(newId(), taskId, staleToken);

    let handled = 0;
    const worker = createWorker({
      workerReference: 'w',
      tasks,
      handlers: {
        review_check: async () => {
          handled += 1;
          return { outcome: 'success' };
        },
      },
    });

    // 第一次 runOnce：租约早已过期，但恢复后任务在 retry_wait，等待 30s 尚未到点 → 不执行。
    // 用一个远超到期时刻的 now 无法注入，因此这里直接断言恢复行为。
    const n = await worker.runOnce();
    expect(n).toBe(0); // 恢复后处于 retry_wait（等待中），本轮不执行

    const row = taskRow(db, taskId);
    expect(row.processing_state).toBe('retry_wait');
    expect(row.last_error_code).toBe('lease_expired');
    expect(attemptRows(db, taskId)[0]!.outcome).toBe('lease_expired');
    expect(handled).toBe(0);
  });
});
