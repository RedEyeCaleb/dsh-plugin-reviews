/**
 * 我的整合包：我创建的 / 我收藏的 两个子页。
 *
 * 创建页的状态：未提交 / 待审核 / 需补充 / 已发布 / 已撤回 / 已拒绝；
 * 收藏页绑定包本身，全部版本不可公开时保留状态。
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { isAuthenticated } from '@/server/platform/context';
import { createPacksService } from '@/server/modules/packs';
import { currentContext } from '../../api/_lib/context';
import { MeNav } from '@/components/me-nav';
import { PackReleaseActions } from '@/components/pack-release-actions';
import { PackAppealForm } from '@/components/pack-appeal-form';
import { formatDateTimeOr } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

function first(sp: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const raw = sp[key];
  return Array.isArray(raw) ? raw[0] : raw;
}

function statusLabel(pack: {
  reviewStatus?: string;
  autoCheckResult?: string | null;
  withdrawn?: boolean;
  hidden?: boolean;
}): string {
  if (pack.reviewStatus === 'draft') return '未提交';
  if (pack.reviewStatus === 'pending') {
    return pack.autoCheckResult === 'verifying' ? '核验中' : '待审核';
  }
  if (pack.reviewStatus === 'rejected') {
    return pack.autoCheckResult === 'needs_info' ? '需补充' : '已拒绝';
  }
  if (pack.hidden) return '已被隐藏';
  if (pack.withdrawn) return '已撤回';
  return '已发布';
}

export default async function MyPacksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await currentContext();
  if (!isAuthenticated(ctx)) redirect('/onboarding?returnTo=/me/packs');

  const sp = await searchParams;
  const tab = first(sp, 'tab') === 'favorites' ? 'favorites' : 'owned';
  const pageRaw = Number.parseInt(first(sp, 'page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  const service = createPacksService({ db: getDb() });
  const owned = tab === 'owned' ? await service.listMyPacks(ctx) : [];
  const favorite = tab === 'favorites' ? await service.listFavoritePacks(ctx, { page, page_size: 20 }) : null;

  const tabHref = (next: 'owned' | 'favorites'): string =>
    next === 'owned' ? '/me/packs' : '/me/packs?tab=favorites';

  return (
    <div>
      <h1>我的整合包</h1>
      <div className="me-layout">
        <MeNav current="packs" />
        <div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            <Link href={tabHref('owned')} className={tab === 'owned' ? 'button primary' : 'button'}>
              我创建的
            </Link>
            <Link href={tabHref('favorites')} className={tab === 'favorites' ? 'button primary' : 'button'}>
              我收藏的
            </Link>
            {tab === 'owned' ? (
              <Link href="/me/packs/new" className="button" style={{ marginLeft: 'auto' }}>
                新建整合包
              </Link>
            ) : null}
          </div>

          {tab === 'owned' ? (
            <section className="panel" aria-label="我创建的整合包">
              <div className="section-head">
                <h2>我创建的（{owned.length}）</h2>
              </div>
              {owned.length === 0 ? (
                <p className="empty" style={{ marginBottom: 0 }}>
                  还没有整合包。可以从收藏夹一键创建一个组合，并给每个插件标上版本与安装目标。
                </p>
              ) : (
                <ul className="item-list">
                  {owned.map((pack) => (
                    <li key={pack.packId} className="item">
                      <div className="item-body">
                        <div className="item-head">
                          <span
                            className={
                              pack.reviewStatus === 'published' && !pack.withdrawn && !pack.hidden
                                ? 'tag site'
                                : 'tag warn'
                            }
                          >
                            {statusLabel(pack)}
                          </span>
                          <div className="item-main">
                            <h3 className="item-title">
                              <Link href={`/packs/${pack.packId}`}>{pack.title}</Link>
                            </h3>
                            <div className="list-meta">
                              <span className="truncate">{pack.purpose}</span>
                              <span>{pack.pluginCount} 个插件</span>
                              <span>{pack.favoriteCount} 收藏</span>
                              <span>{formatDateTimeOr(pack.publishedAt, '时间未知')}</span>
                              {pack.reviewNote ? (
                                <span className="muted">审核意见：{pack.reviewNote}</span>
                              ) : null}
                              {/*
                                被退回的版本给「申请复核」入口：自动检查/核验/人工审核都可能误判，
                                作者需要一条正式通道，而不是只能默默改稿重交（重交会丢掉争议记录）。
                              */}
                              {pack.reviewStatus === 'rejected' ? (
                                <span>
                                  <PackAppealForm releaseId={pack.releaseId} />
                                </span>
                              ) : null}
                              <span style={{ marginLeft: 'auto' }}>
                                <PackReleaseActions
                                  releaseId={pack.releaseId}
                                  packId={pack.packId}
                                  reviewStatus={pack.reviewStatus ?? 'draft'}
                                  withdrawn={pack.withdrawn ?? false}
                                />
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          {tab === 'favorites' && favorite ? (
            <section className="panel" aria-label="我收藏的整合包">
              <div className="section-head">
                <h2>我收藏的（{favorite.total}）</h2>
              </div>
              {favorite.items.length === 0 ? (
                <p className="empty" style={{ marginBottom: 0 }}>
                  还没有收藏别人的整合包。去<Link href="/packs">整合包广场</Link>看看。
                </p>
              ) : (
                <ul className="item-list">
                  {favorite.items.map((pack) => (
                    <li key={pack.packId} className="item">
                      <div className="item-body">
                        <h3>
                          {pack.hasPublicRelease ? (
                            <Link href={`/packs/${pack.packId}`}>{pack.title}</Link>
                          ) : (
                            <span className="muted">{pack.title}</span>
                          )}
                        </h3>
                        <div className="list-meta">
                          <span>作者 {pack.authorNickname}</span>
                          {pack.hasPublicRelease ? (
                            <>
                              <span>{pack.pluginCount} 个插件</span>
                              <span>第 {pack.releaseNumber} 版</span>
                            </>
                          ) : (
                            <span className="tag warn">
                              {pack.hidden ? '已被隐藏' : '暂无可公开版本'}
                            </span>
                          )}
                          <span>{pack.favoriteCount} 收藏</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {favorite.total_pages > 1 ? (
                <div className="pagination" style={{ marginTop: 12 }}>
                  {favorite.page > 1 ? (
                    <Link href={`/me/packs?tab=favorites&page=${favorite.page - 1}`} className="button">
                      ← 上一页
                    </Link>
                  ) : (
                    <span className="button" aria-disabled="true">← 上一页</span>
                  )}
                  <span className="muted">
                    第 {favorite.page} / {favorite.total_pages} 页
                  </span>
                  {favorite.page < favorite.total_pages ? (
                    <Link href={`/me/packs?tab=favorites&page=${favorite.page + 1}`} className="button">
                      下一页 →
                    </Link>
                  ) : (
                    <span className="button" aria-disabled="true">下一页 →</span>
                  )}
                </div>
              ) : null}
            </section>
          ) : null}

          <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
            版本一旦发布即冻结：修正内容需要发布新版本，旧版本保持可查。
          </p>
        </div>
      </div>
    </div>
  );
}
