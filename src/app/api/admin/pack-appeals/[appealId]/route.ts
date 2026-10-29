/** 管理员处理整合包复核申请：overturn（改判发布）/ uphold（维持原判）。 */
import { getDb } from '@/server/platform/db';
import { isAdmin } from '@/server/platform/context';
import { createPacksService } from '@/server/modules/packs';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../_lib/context';
import { err } from '@/packages/common/errors';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ appealId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { appealId } = await params;
    const ctx = await currentContext();
    // 先认人再读 body：匿名 + 非法 body 应当是 403，不是 400。
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');
    const body = (await readJson(request)) as { decision?: unknown; note?: unknown };
    if (body.decision !== 'overturn' && body.decision !== 'uphold') {
      throw err.input('decision 必须是 overturn 或 uphold。', [{ path: 'decision', message: '不合法' }]);
    }
    const service = createPacksService({ db: getDb() });
    const result = await service.resolveAppeal(
      ctx,
      appealId,
      body.decision,
      typeof body.note === 'string' ? body.note : null,
    );
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
