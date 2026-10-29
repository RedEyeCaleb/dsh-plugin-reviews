-- 0025_pack_auto_check.sql
--
-- 整合包提交后的自动检查结果：pass（自动发布）/ needs_info（提示补充）/ manual（转人工）。
-- 状态仍用 review_status：published / rejected（needs_info 时）/ pending（manual 时）。

ALTER TABLE plugin_pack_releases
  ADD COLUMN auto_check_result TEXT
  CHECK (auto_check_result IS NULL OR auto_check_result IN ('pass', 'needs_info', 'manual', 'verifying'));
