/** 整合包版本复核申请：提交（POST）与查看历史（GET）。 */
import { getDb } from '@/server/platform/db';
import { createPacksService } from '@/server/modules/packs';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../_lib/context';
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
    const body = (await readJson(request)) as { message?: unknown };
    if (typeof body.message !== 'string') {
      throw err.input('申诉说明缺失。', [{ path: 'message', message: '必填' }]);
    }
    const service = createPacksService({ db: getDb() });
    const result = await service.submitAppeal(ctx, releaseId, body.message);
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ releaseId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { releaseId } = await params;
    const ctx = await currentContext();
    const service = createPacksService({ db: getDb() });
    const items = await service.listAppealsForRelease(ctx, releaseId);
    return okJson({ items }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
