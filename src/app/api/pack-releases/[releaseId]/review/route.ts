/** 管理员审核整合包版本：approve / reject。 */
import { getDb } from '@/server/platform/db';
import { createPacksService } from '@/server/modules/packs';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../_lib/context';
import { isAdmin } from '@/server/platform/context';
import { err } from '@/packages/common/errors';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ releaseId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { releaseId } = await params;
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('只有管理员可以审核整合包。');
    const body = (await readJson(request)) as { action?: unknown; note?: unknown };
    const service = createPacksService({ db: getDb() });
    if (body.action === 'approve') {
      const result = await service.approveRelease(ctx, releaseId);
      return okJson(result, requestId);
    }
    if (body.action === 'reject') {
      const result = await service.rejectRelease(
        ctx,
        releaseId,
        typeof body.note === 'string' ? body.note : null,
      );
      return okJson(result, requestId);
    }
    throw err.input('action 必须是 approve 或 reject。', [{ path: 'action', message: '不合法' }]);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
