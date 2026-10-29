-- 0023_pack_review_and_draft.sql
--
-- 整合包版本生命周期：草稿（未上传）→ 待审核 → 已发布 / 已拒绝。
--
-- 规则：
--   * 创建整合包先落草稿版本（release_number NULL），不进入公开列表；
--   * 作者上传整合包文件后进入待审核（review_status='pending'）；
--   * 管理员通过时在发布事务里分配 release_number 并置 published；
--   * 拒绝时记录 review_note，作者修改后可重新上传提交；
--   * 已发布版本撤回沿用 content_entities.withdrawn_at（不删快照）。

ALTER TABLE plugin_pack_releases
  ADD COLUMN review_status TEXT NOT NULL DEFAULT 'draft'
  CHECK (review_status IN ('draft', 'pending', 'published', 'rejected'));

ALTER TABLE plugin_pack_releases
  ADD COLUMN review_note TEXT;

UPDATE plugin_pack_releases
   SET review_status = 'published'
 WHERE release_number IS NOT NULL;
