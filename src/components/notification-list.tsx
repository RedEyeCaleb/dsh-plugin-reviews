'use client';

/**
 * 通知收件箱（`idea.md §11`）。
 *
 * 全部来自 `GET /api/me/notifications`：列表 + 未读数。
 * 「全部标为已读」走 `POST /api/me/notifications/read`（幂等，所以不要请求键）。
 * 不做"点开某条跳到评论"的深链接 —— 本切片的内容页锚点还没有稳定约定，
 * 与其做一个跳不准的按钮，不如先把列表与已读做对。
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { formatDateTime } from '@/packages/common/time';
import { ApiError, ErrorNotice, apiFetch } from './api-client';
import { SkeletonLines } from './skeleton';

interface NotificationItem {
  id: string;
  kind: 'comment_on_content' | 'reply_to_comment' | 'moderation_result';
  commentId: string | null;
  contentEntityId: string | null;
  href: string | null;
  actorNickname: string;
  actorAvatarUrl: string | null;
  excerpt: string;
  readAt: number | null;
  createdAt: number;
}

interface Inbox {
  items: NotificationItem[];
  unreadCount: number;
}

export function NotificationList() {
  const [data, setData] = useState<Inbox | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [onlyUnread, setOnlyUnread] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await apiFetch<Inbox>(
        `/api/me/notifications?limit=50${onlyUnread ? '&unread_only=1' : ''}`,
        { cache: 'no-store' },
      );
      setData(result);
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    }
  }, [onlyUnread]);

  useEffect(() => {
    void load();
  }, [load]);

  const markAllRead = async () => {
    setBusy(true);
    try {
      await apiFetch('/api/me/notifications/read', { method: 'POST', json: { all: true } });
      await load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const markOne = async (id: string) => {
    setBusy(true);
    try {
      await apiFetch('/api/me/notifications/read', { method: 'POST', json: { ids: [id] } });
      await load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      {/* 工具栏：左侧是状态与筛选，右侧是批量操作（都在同一条 section-head 上，不再把按钮甩到最右边） */}
      <div className="section-head" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {data !== null ? (
            <span className={data.unreadCount > 0 ? 'tag site' : 'tag'} style={{ margin: 0 }}>
              未读 {data.unreadCount}
            </span>
          ) : null}
          {/*
            「只看未读」做成**可切换按钮**（M3 filter chip 的形态），不再用复选框：
            复选框的勾选方块与左边的"未读 N"徽标不在同一条基线上，看着别扭；
            按钮和徽标同高（都吃 --chip-height），自然对齐。
          */}
          <button
            type="button"
            className={onlyUnread ? 'tag site filter-toggle' : 'tag filter-toggle'}
            aria-pressed={onlyUnread}
            onClick={() => setOnlyUnread((value) => !value)}
            style={{ margin: 0 }}
          >
            只看未读
          </button>
        </div>
        <button
          type="button"
          onClick={() => void markAllRead()}
          disabled={busy || data === null || data.unreadCount === 0}
          className="button"
        >
          全部标为已读
        </button>
      </div>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}

      {data === null ? (
        <SkeletonLines lines={3} label="正在读取通知…" />
      ) : data.items.length === 0 ? (
        <p className="empty" style={{ marginBottom: 0 }}>
          {onlyUnread
            ? '没有未读通知。'
            : '还没有通知。别人评论或回复你时，会出现在这里。'}
        </p>
      ) : (
        <ul className="item-list">
          {data.items.map((n) => (
            <li
              key={n.id}
              /* 未读=强调色左边框 + 淡底；已读=静默态（设计系统的 .notice.quiet） */
              className={n.readAt === null ? 'notice' : 'notice quiet'}
              style={{ marginBottom: 10 }}
            >
              <div style={{ fontSize: 14 }}>
                <strong>{n.actorNickname}</strong>
                {n.kind === 'reply_to_comment'
                  ? ' 回复了你的评论'
                  : n.kind === 'moderation_result'
                    ? ' 处理结果'
                    : ' 评论了你的内容'}
                <span className="muted">
                  {' · '}
                  {formatDateTime(n.createdAt)}
                  {n.readAt === null ? '' : '（已读）'}
                </span>
              </div>
              <div style={{ marginTop: 6, color: 'var(--ink)', whiteSpace: 'pre-wrap' }}>{n.excerpt}</div>
              <div style={{ marginTop: 6, display: 'flex', gap: 12, alignItems: 'center' }}>
                {n.href ? (
                  <Link href={n.href} className="link-btn">
                    去看这条内容
                  </Link>
                ) : null}
                {n.readAt === null ? (
                  <button type="button" disabled={busy} onClick={() => void markOne(n.id)} className="link-btn muted">
                    标为已读
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
