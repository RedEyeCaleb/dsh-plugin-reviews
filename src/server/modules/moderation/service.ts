/**
 * 内容审核服务（工作包 GT）。
 *
 * 权威依据：
 *  - 已删除的设计稿《模块签名契约》 第 6 节（签名）与第 151 行（未配置筛查的硬规则）；
 *  - migrations/0001_baseline.sql §3.4-3.5（表结构与 CHECK）；
 *  - 并行工作包 §2.10（状态机与"绝不自动放行"）。
 *
 * 两条**不得违反**的硬规则：
 *  1. **未知版本不构成退回理由**（契约第 26 节 / field-rules 的 VersionValue）。
 *     `{kind:'unknown'}` 是合法的"明确未知"，与字段缺失不同。
 *  2. **外部内容筛查未配置时绝不自动放行、也不认定违规**：
 *     停在 `manual_review`（或回 `pending` 并记 `fault`），永不自动 `approved`。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { withTransaction } from '@/server/platform/tx';
import type { Tx } from '@/server/platform/tx';
import { newId } from '@/server/platform/id';
import { nowMs } from '@/server/platform/time';
import { isAdmin } from '@/server/platform/context';
import type { CallerContext } from '@/server/platform/context';
import type {
  ModerationActorKind,
  ModerationResult,
  SubmissionState,
} from '@/packages/common/field-rules';
import type { FieldError } from '@/packages/common/errors';
import { err } from '@/packages/common/errors';
import { deliverModerationResultNotification } from '@/server/modules/notifications';

/** 处理记录阶段（与 0001 §3.4 的 CHECK 一致）。 */
export type ModerationStage = 'rule_check' | 'content_screen' | 'manual_review' | 'publish';

/** 版本结构的最小形状（见 field-rules.ts 的 VersionKnown / VersionUnknown）。 */
interface VersionShape {
  kind?: unknown;
  value?: unknown;
}

export interface RuleCheckOutcome {
  result: ModerationResult;
  /** 退回理由的稳定字段路径（例如 `title`、`plugin_version`）。 */
  fields: FieldError[];
  /** 建议到达的状态。 */
  nextState: SubmissionState;
}

export interface ModerationService {
  runRuleCheck(submissionId: string, taskId: string): Promise<void>;
  appendRecord(input: {
    submissionId: string;
    operationKey: string;
    stage: ModerationStage;
    result: ModerationResult;
    actorKind: ModerationActorKind;
    actorUserId: string | null;
    taskId: string | null;
    reason: string;
    evidence: unknown;
  }): Promise<string>;
  transition(
    submissionId: string,
    input: { expectedStateVersion: number; to: SubmissionState; reason: string },
  ): Promise<{ stateVersion: number }>;
  decideByAdmin(
    ctx: CallerContext,
    input: {
      submissionId: string;
      decision: 'approve' | 'needs_changes';
      reason: string;
      expectedStateVersion: number;
      requestKey: string;
    },
  ): Promise<{ state: SubmissionState }>;
}

interface SubmissionRow {
  id: string;
  submission_type: 'review_revision' | 'comment_revision';
  review_revision_id: string | null;
  comment_revision_id: string | null;
  processing_state: SubmissionState;
  state_version: number;
}

/**
 * 判定一个版本字段是否"已知或明确未知"。
 *
 * 合法：`{kind:'known', value:'<非空>'}` 或 `{kind:'unknown'}`。
 * 非法（才算缺项）：缺失、非对象、kind 不在枚举内、known 却没给非空 value。
 *
 * **`{kind:'unknown'}` 返回 true** —— 未知不构成退回理由。
 */
export function isVersionResolved(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  if (typeof raw !== 'object' || Array.isArray(raw)) return false;
  const v = raw as VersionShape;
  if (v.kind === 'unknown') return true;
  if (v.kind === 'known') return typeof v.value === 'string' && v.value.trim().length > 0;
  return false;
}

/** 解析库里的版本 JSON 文本；坏 JSON 视为缺项（不静默放行）。 */
function parseVersion(raw: string | null): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * 纯函数规则校验：不碰数据库，便于单测直接覆盖判定逻辑。
 * 输入是"提交快照的展开视图"。
 */
export function evaluateRules(snapshot: {
  submissionType: 'review_revision' | 'comment_revision';
  title?: string | null;
  pluginId?: string | null;
  pluginVersion?: unknown;
  dshVersion?: unknown;
}): RuleCheckOutcome {
  const fields: FieldError[] = [];

  if (snapshot.submissionType === 'review_revision') {
    // 标题非空（trim 后）。
    if (typeof snapshot.title !== 'string' || snapshot.title.trim() === '') {
      fields.push({ path: 'title', message: '标题不能为空。' });
    }
    // 插件必须已绑定：发布一律要求确定插件（reviews 的 CHECK 也是这个意思）。
    if (snapshot.pluginId === null || snapshot.pluginId === undefined || snapshot.pluginId === '') {
      fields.push({ path: 'plugin_id', message: '评测必须绑定一个已收录插件。' });
    }
    // 版本字段：必须"已知或明确未知"。未知**不**构成退回理由。
    if (!isVersionResolved(snapshot.pluginVersion)) {
      fields.push({
        path: 'plugin_version',
        message: '插件版本必须填写具体版本，或明确标记为未知（kind="unknown"）。',
      });
    }
    if (!isVersionResolved(snapshot.dshVersion)) {
      fields.push({
        path: 'dsh_version',
        message: 'DSH 版本必须填写具体版本，或明确标记为未知（kind="unknown"）。',
      });
    }
  }

  if (fields.length > 0) {
    return { result: 'needs_changes', fields, nextState: 'needs_changes' };
  }
  // 规则通过 → 进入外部内容筛查阶段（是否真的能过由筛查配置决定）。
  return { result: 'pass', fields: [], nextState: 'checking' };
}

export interface ModerationOptions {
  /**
   * 外部内容筛查适配器。**未注入即视为未配置**。
   * 返回 'pass' / 'violation' / 'inconclusive'；抛错视为故障。
   * 适配器必须在事务外调用（本服务会在进入事务前先调用它）。
   */
  contentScreen?: (input: { submissionId: string; snapshot: unknown }) => Promise<'pass' | 'violation' | 'inconclusive'>;
}

export function createModerationService(db: SqliteDatabase, options: ModerationOptions = {}): ModerationService {
  function loadSubmission(handle: SqliteDatabase, submissionId: string): SubmissionRow {
    const row = handle
      .prepare(
        `SELECT id, submission_type, review_revision_id, comment_revision_id, processing_state, state_version
           FROM content_submissions WHERE id = ?`,
      )
      .get(submissionId) as SubmissionRow | undefined;
    if (!row) throw err.unavailable('提交记录不存在。');
    return row;
  }

  /** 读取提交对应的快照视图（评测修订）。 */
  function loadSnapshot(handle: SqliteDatabase, row: SubmissionRow): {
    submissionType: 'review_revision' | 'comment_revision';
    title?: string | null;
    pluginId?: string | null;
    pluginVersion?: unknown;
    dshVersion?: unknown;
  } {
    if (row.submission_type !== 'review_revision') {
      return { submissionType: 'comment_revision' };
    }
    const rev = handle
      .prepare(
        `SELECT title, plugin_id, plugin_version, dsh_version
           FROM review_revisions WHERE id = ?`,
      )
      .get(row.review_revision_id) as
      | { title: string; plugin_id: string; plugin_version: string; dsh_version: string }
      | undefined;
    if (!rev) return { submissionType: 'review_revision', title: null, pluginId: null };
    return {
      submissionType: 'review_revision',
      title: rev.title,
      pluginId: rev.plugin_id,
      pluginVersion: parseVersion(rev.plugin_version),
      dshVersion: parseVersion(rev.dsh_version),
    };
  }

  function appendRecordWithin(
    handle: SqliteDatabase,
    input: Parameters<ModerationService['appendRecord']>[0],
    now: number,
  ): string {
    if (!input.operationKey || input.operationKey.trim() === '') {
      throw err.input('operation_key 不能为空。', [{ path: 'operationKey', message: '必填' }]);
    }
    // 表 CHECK：system 身份必须有 task_id；user/admin 身份必须有 actor_user_id。
    // 在写库前先给出可读错误（否则只会得到 SQLite 约束报错）。
    if (input.actorKind === 'system' && input.taskId === null) {
      throw err.input('系统身份的处理记录必须关联 task_id。', [{ path: 'taskId', message: '系统身份必填' }]);
    }
    if (input.actorKind !== 'system' && input.actorUserId === null) {
      throw err.input('人工身份的处理记录必须关联 actor_user_id。', [
        { path: 'actorUserId', message: '人工身份必填' },
      ]);
    }
    if (!input.reason || input.reason.trim() === '') {
      throw err.input('处理原因不能为空。', [{ path: 'reason', message: '必填' }]);
    }

    const existing = handle
      .prepare('SELECT id FROM content_moderation_records WHERE submission_id = ? AND operation_key = ?')
      .get(input.submissionId, input.operationKey) as { id: string } | undefined;
    if (existing) return existing.id;

    const id = newId();
    handle
      .prepare(
        `INSERT INTO content_moderation_records
           (id, submission_id, operation_key, stage, result, actor_kind, actor_user_id, task_id,
            reason, evidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.submissionId,
        input.operationKey,
        input.stage,
        input.result,
        input.actorKind,
        input.actorUserId,
        input.taskId,
        input.reason,
        JSON.stringify(input.evidence ?? null),
        now,
      );
    return id;
  }

  /** 带 state_version 校验的状态转换（内部复用）。 */
  function transitionWithin(
    handle: SqliteDatabase,
    submissionId: string,
    input: { expectedStateVersion: number; to: SubmissionState; reason: string },
    now: number = nowMs(),
  ): { stateVersion: number } {
    const row = loadSubmission(handle, submissionId);

    // CAS：版本不符 → 冲突，且不改任何状态。
    if (row.state_version !== input.expectedStateVersion) {
      throw err.conflict('提交状态已被其他操作改变，请刷新后重试。', {
        submission_id: submissionId,
        current_state_version: row.state_version,
        expected_state_version: input.expectedStateVersion,
      });
    }

    const nextVersion = row.state_version + 1;
    const result = handle
      .prepare(
        `UPDATE content_submissions
            SET processing_state = ?, state_version = ?, updated_at = ?
          WHERE id = ? AND state_version = ?`,
      )
      .run(input.to, nextVersion, now, submissionId, input.expectedStateVersion);

    if (result.changes !== 1) {
      throw err.conflict('提交状态并发更新冲突。', { submission_id: submissionId });
    }
    return { stateVersion: nextVersion };
  }

  return {
    /**
     * 规则校验 + 内容筛查编排。
     *
     * 顺序：
     *  1. pending → checking（规则校验前的阶段推进）；
     *  2. 规则缺项 → 记 needs_changes，转到 needs_changes 并返回；
     *  3. 规则通过 → 调外部筛查（**未配置即视为不可自动放行**）：
     *     - 未配置 → 记 fault，转 manual_review；
     *     - 故障   → 记 fault，转 manual_review；
     *     - 不确定 → 记 manual_review，转 manual_review；
     *     - violation → 记 needs_changes，转 needs_changes；
     *     - pass → 记 pass，转 approved。
     */
    async runRuleCheck(submissionId, taskId) {
      if (!taskId || taskId.trim() === '') {
        throw err.input('规则校验必须关联一个任务。', [{ path: 'taskId', message: '必填' }]);
      }

      // ---- 事务 1：读快照、跑规则、推进到 checking ----
      const prepared = withTransaction((tx: Tx) => {
        const handle = tx.db;
        const row = loadSubmission(handle, submissionId);
        const snapshot = loadSnapshot(handle, row);
        const outcome = evaluateRules(snapshot);

        if (outcome.result === 'needs_changes') {
          appendRecordWithin(
            handle,
            {
              submissionId,
              operationKey: `rule_check:${taskId}`,
              stage: 'rule_check',
              result: 'needs_changes',
              actorKind: 'system',
              actorUserId: null,
              taskId,
              reason: `规则校验未通过：${outcome.fields.map((f) => f.path).join('、')}`,
              evidence: { fields: outcome.fields },
            },
            nowMs(),
          );
          // 从当前状态转到 needs_changes（无论 pending 还是 checking）。
          transitionWithin(handle, submissionId, {
            expectedStateVersion: row.state_version,
            to: 'needs_changes',
            reason: '规则校验缺项',
          });
          return { kind: 'needs_changes' as const, fields: outcome.fields };
        }

        // 规则通过：先推进到 checking（若已在 checking 则跳过，避免无谓版本递增）。
        let version = row.state_version;
        if (row.processing_state !== 'checking') {
          version = transitionWithin(handle, submissionId, {
            expectedStateVersion: row.state_version,
            to: 'checking',
            reason: '规则校验通过，进入内容筛查',
          }).stateVersion;
        }
        return { kind: 'checking' as const, stateVersion: version, snapshot };
      }, db);

      if (prepared.kind === 'needs_changes') return;

      // ---- 外部筛查：**在事务之外**调用（不得在事务内做网络请求） ----
      let screenResult: 'pass' | 'violation' | 'inconclusive' | 'fault' | 'not_configured';
      if (!options.contentScreen) {
        screenResult = 'not_configured';
      } else {
        try {
          screenResult = await options.contentScreen({ submissionId, snapshot: prepared.snapshot });
        } catch {
          screenResult = 'fault';
        }
      }

      // ---- 事务 2：按筛查结果落记录并转状态 ----
      withTransaction((tx: Tx) => {
        const handle = tx.db;
        const row = loadSubmission(handle, submissionId);
        const now = nowMs();

        if (screenResult === 'pass') {
          appendRecordWithin(
            handle,
            {
              submissionId,
              operationKey: `content_screen:${taskId}`,
              stage: 'content_screen',
              result: 'pass',
              actorKind: 'system',
              actorUserId: null,
              taskId,
              reason: '外部内容筛查通过。',
              evidence: { source: 'content_screen' },
            },
            now,
          );
          transitionWithin(handle, submissionId, {
            expectedStateVersion: row.state_version,
            to: 'approved',
            reason: '规则校验与内容筛查均通过',
          });
          return;
        }

        if (screenResult === 'violation') {
          appendRecordWithin(
            handle,
            {
              submissionId,
              operationKey: `content_screen:${taskId}`,
              stage: 'content_screen',
              result: 'needs_changes',
              actorKind: 'system',
              actorUserId: null,
              taskId,
              reason: '外部内容筛查判定违规。',
              evidence: { source: 'content_screen', decision: 'violation' },
            },
            now,
          );
          transitionWithin(handle, submissionId, {
            expectedStateVersion: row.state_version,
            to: 'needs_changes',
            reason: '内容筛查判定违规',
          });
          return;
        }

        // not_configured / fault / inconclusive 一律**不自动放行**，停在 manual_review。
        const isFault = screenResult === 'fault' || screenResult === 'not_configured';
        appendRecordWithin(
          handle,
          {
            submissionId,
            operationKey: `content_screen:${taskId}`,
            stage: 'content_screen',
            result: isFault ? 'fault' : 'manual_review',
            actorKind: 'system',
            actorUserId: null,
            taskId,
            reason:
              screenResult === 'not_configured'
                ? '外部内容筛查未配置，转人工复核（不自动放行）。'
                : screenResult === 'fault'
                  ? '外部内容筛查故障，转人工复核（不自动放行）。'
                  : '外部内容筛查结果不确定，转人工复核。',
            evidence: { source: 'content_screen', decision: screenResult },
          },
          now,
        );
        transitionWithin(handle, submissionId, {
          expectedStateVersion: row.state_version,
          to: 'manual_review',
          reason: '内容筛查未通过自动判据，转人工复核',
        });
      }, db);
    },

    /** 追加处理记录（幂等：同 (submission_id, operation_key) 返回原记录 ID）。 */
    async appendRecord(input) {
      return withTransaction((tx: Tx) => appendRecordWithin(tx.db, input, nowMs()), db);
    },

    /** 状态转换：校验 state_version，通过则原子递增。 */
    async transition(submissionId, input) {
      return withTransaction((tx: Tx) => transitionWithin(tx.db, submissionId, input, nowMs()), db);
    },

    /** 管理员人工决定：approve → approved；needs_changes → needs_changes。 */
    async decideByAdmin(ctx, input) {
      if (!isAdmin(ctx)) {
        throw err.forbidden('只有管理员可以做出审核决定。');
      }
      if (!input.requestKey || input.requestKey.trim() === '') {
        throw err.input('request_key 不能为空。', [{ path: 'requestKey', message: '必填' }]);
      }
      const adminId = ctx.userId as string;

      return withTransaction((tx: Tx) => {
        const handle = tx.db;
        const row = loadSubmission(handle, input.submissionId);
        const now = nowMs();

        if (row.state_version !== input.expectedStateVersion) {
          throw err.conflict('提交状态已被其他操作改变，请刷新后重试。', {
            submission_id: input.submissionId,
            current_state_version: row.state_version,
          });
        }

        const to: SubmissionState = input.decision === 'approve' ? 'approved' : 'needs_changes';
        const result: ModerationResult = input.decision === 'approve' ? 'pass' : 'needs_changes';

        // 人工决定记录：actorKind 按 ctx.role 记为 admin；task_id 为空（人工身份不要求）。
        appendRecordWithin(
          handle,
          {
            submissionId: input.submissionId,
            operationKey: input.requestKey,
            stage: 'manual_review',
            result,
            actorKind: 'admin',
            actorUserId: adminId,
            taskId: null,
            reason: input.reason,
            evidence: { decision: input.decision, actor_user_id: adminId },
          },
          now,
        );

        const out = transitionWithin(handle, input.submissionId, {
          expectedStateVersion: input.expectedStateVersion,
          to,
          reason: input.reason,
        });

        // 审核结果通知作者：此前人工决定只写记录、作者只能自己回来刷新页面看状态。
        // 评测修订挂在自己的 content_entities 上（发布后就是那篇评测），评论修订同理。
        // 找不到内容锚点时不发（宁可不发，也不发一条指向空气的通知）。
        const anchor = handle
          .prepare(
            `SELECT ce.id AS content_entity_id, ce.author_id AS author_id
               FROM content_submissions s
               JOIN review_revisions rr ON rr.id = s.review_revision_id
               JOIN content_entities ce ON ce.id = rr.review_id
              WHERE s.id = ?`,
          )
          .get(input.submissionId) as { content_entity_id: string; author_id: string } | undefined;
        if (anchor) {
          deliverModerationResultNotification(handle, {
            recipientId: anchor.author_id,
            actorId: adminId,
            contentEntityId: anchor.content_entity_id,
            detail:
              input.decision === 'approve'
                ? '你的评测已通过审核，正在发布。'
                : `你的评测需要修改后才能发布：${input.reason.trim() || '请按审核意见修改后重新提交。'}`,
            deduplicationKey: `review_decision:${input.submissionId}:${input.requestKey}`,
            now,
          });
        }

        return { state: to, stateVersion: out.stateVersion };
      }, db);
    },
  };
}

let singleton: ModerationService | null = null;

/** 进程级单例。内容筛查适配器由调用方在装配时注入（未注入即未配置）。 */
export function moderationService(options: ModerationOptions = {}): ModerationService {
  if (!singleton) singleton = createModerationService(getDb(), options);
  return singleton;
}

export function resetModerationService(): void {
  singleton = null;
}
