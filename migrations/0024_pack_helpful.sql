-- 0024_pack_helpful.sql
--
-- 整合包版本的「有帮助」投票（与评测的 review_helpful_votes 分开）。
-- 与评论/举报一样按具体版本计，不跨版本。

CREATE TABLE pack_release_helpful_votes (
  user_id    TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  release_id TEXT    NOT NULL REFERENCES plugin_pack_releases(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (user_id, release_id)
);

CREATE INDEX idx_pack_helpful_by_release ON pack_release_helpful_votes(release_id);
