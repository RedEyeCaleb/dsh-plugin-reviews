-- 0026_pack_install_checks.sql
--
-- 整合包版本的安装资料核验记录（架构 §36.2）。
-- 提交时先写 pending；异步核验完成后更新为 ok / failed / skipped。
-- 「关键目标」= npm 包版本 / GitHub 提交；子路径等非关键失败不阻塞。

CREATE TABLE plugin_install_checks (
  id                 TEXT    PRIMARY KEY,
  release_item_id    TEXT    NOT NULL REFERENCES plugin_pack_release_items(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  target_fingerprint TEXT    NOT NULL CHECK (trim(target_fingerprint) <> ''),
  check_sequence     INTEGER NOT NULL CHECK (check_sequence > 0),
  target_kind        TEXT    NOT NULL CHECK (target_kind IN ('npm', 'github', 'none')),
  state              TEXT    NOT NULL CHECK (state IN ('pending', 'ok', 'failed', 'skipped')),
  detail             TEXT,
  requested_at       INTEGER NOT NULL CHECK (requested_at >= 0),
  completed_at       INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
  UNIQUE (release_item_id, check_sequence)
);

CREATE INDEX idx_install_checks_by_item ON plugin_install_checks(release_item_id, check_sequence DESC);
