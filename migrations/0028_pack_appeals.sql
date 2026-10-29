-- 0028_pack_appeals.sql
--
-- 整合包版本的「复核申请」（申诉）。
--
-- 注：编号 0027 在本轮拆分中未使用（0026 → 0028），文件名保持不变以免与已分发版本冲突；
-- 迁移器按文件名排序执行，空档不影响顺序。
--
-- 背景：自动检查（迁移 0025）与安装资料核验（迁移 0026）会直接把版本退回（rejected + review_note），
-- 人工审核也会拒绝。这些判定可能错（规则误判、网络抖动导致核验失败、安装目标写法生僻），
-- 作者需要一个**正式的申诉通道**，而不是只能默默改稿重交——重交会丢掉"我认为这次判定是错的"
-- 这层信息，管理员也看不到争议发生过。
--
-- 设计取舍（如实记录）：
--   * **一张独立表**，不塞进 plugin_pack_releases 的列：一个版本可能被拒多次、申诉多次，
--     历史必须留在库里（"这个版本的判定到底被推翻过几次"是可审计事实）。
--   * **同一版本同时只能有一条待处理申诉**：用部分唯一索引
--     （`WHERE state = 'pending'`）在数据库层保证，而不是靠应用层先查后插——
--     并发下两次提交也不会出现两条待审，管理员不会重复处理同一次申诉。
--   * `auto_check_result` / `review_note` 的**快照**存在申诉行里（`snapshot_auto_check`、
--     `snapshot_note`）：处理申诉的人要看到"作者申诉的是哪一次判定"，而 version 行随后会被
--     改（比如通过后变成 published），事后回看不清当时的状态。
--   * 结果用 `state`：pending（待处理）/ upheld（维持原判）/ overturned（改判，已发布）。
--     不做 'partially' 之类中间态——两种结论足够，也说人话。
--   * 申诉人不一定是作者本人吗？是。CHECK 不做，服务层校验（作者身份判定要 JOIN 两张表）。

CREATE TABLE plugin_pack_appeals (
  id                    TEXT    PRIMARY KEY,
  release_id            TEXT    NOT NULL
                          REFERENCES plugin_pack_releases(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  author_id             TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- 作者的话：为什么认为判定有误（必填，至少一句）
  message               TEXT    NOT NULL CHECK (length(trim(message)) BETWEEN 5 AND 2000),
  -- 申诉时的判定现场（事后回看用）
  snapshot_auto_check   TEXT,
  snapshot_note         TEXT,
  state                 TEXT    NOT NULL DEFAULT 'pending'
                          CHECK (state IN ('pending', 'upheld', 'overturned')),
  -- 处理结果：管理员的话 + 结果通知的去重键
  resolution_note       TEXT,
  resolved_by           TEXT    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  resolved_at           INTEGER CHECK (resolved_at IS NULL OR resolved_at >= 0),
  created_at            INTEGER NOT NULL CHECK (created_at >= 0),
  -- 已处理的必须有处理人/时间，待处理的不许有（避免"处理了但没留痕"）
  CHECK ((state = 'pending') = (resolved_at IS NULL)),
  CHECK ((state = 'pending') = (resolved_by IS NULL))
);

-- 同一版本只能有一条待处理申诉（部分唯一索引；其余历史行不限制）
CREATE UNIQUE INDEX uq_pack_appeals_pending
  ON plugin_pack_appeals(release_id) WHERE state = 'pending';

-- 管理员队列：待处理按时间正序
CREATE INDEX idx_pack_appeals_state ON plugin_pack_appeals(state, created_at, id);

-- 作者查自己版本的历史
CREATE INDEX idx_pack_appeals_release ON plugin_pack_appeals(release_id, created_at DESC);
