/** 作者编辑/删除未发布整合包版本。 */
import { getDb } from '@/server/platform/db';
import { createPacksService, type ReleaseInput } from '@/server/modules/packs';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../_lib/context';

export const runtime = 'nodejs';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ releaseId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { releaseId } = await params;
    const ctx = await currentContext();
    const body = (await readJson(request)) as Partial<ReleaseInput>;
    if (body === null || typeof body !== 'object') {
      throw err.input('请求体必须是对象。', [{ path: '', message: '格式不合法' }]);
    }
    const service = createPacksService({ db: getDb() });
    const result = await service.updateDraftRelease(ctx, releaseId, body as ReleaseInput);
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ releaseId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { releaseId } = await params;
    const ctx = await currentContext();
    const service = createPacksService({ db: getDb() });
    const result = await service.deleteDraftRelease(ctx, releaseId);
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
