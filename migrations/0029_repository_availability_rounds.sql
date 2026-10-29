-- 0029_repository_availability_rounds.sql
--
-- 数据保留（规划 §5.3）：连续三轮不可访问 → 标记「暂不可访问」。
--
-- 现状：repositories.availability_state 只有 unknown / available / unavailable，
-- 而"不可访问"是一次探测就能写死的结论 —— 网络抖动、GitHub 偶尔 502、仓库临时归档，
-- 都会让一个好好的插件被标成不可用。规划要求的是**连续三轮**才下结论。
--
-- 做法：加一列连续失败轮次。语义给死：
--   * 每次探测成功 → consecutive_unavailable = 0，state = 'available'；
--   * 每次探测失败 → consecutive_unavailable += 1；累计到 3 才把 state 置 'unavailable'，
--     之前保持原状态（第一次失败不改结论，只在页面上按"最近一次检查失败"说明）；
--   * 上述判定在应用层做（见 plugin-discovery / 后续探测任务），本迁移只提供字段与约束。
--
-- 为什么不在库里放 CHECK "state='unavailable' ⇒ rounds>=3"：库不知道历史，
-- 运维手动改状态（比如确认仓库真的删了）会被这种约束卡住；约束写进应用层更合适。

ALTER TABLE repositories
  ADD COLUMN consecutive_unavailable INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_unavailable >= 0);

-- 已探测过且当前不可用的仓库：按"已满三轮"初始化，避免它们被规则瞬间改回 available
-- （历史结论比新规则更可信：它们当下确实打不开）。
UPDATE repositories
   SET consecutive_unavailable = 3
 WHERE availability_state = 'unavailable';
