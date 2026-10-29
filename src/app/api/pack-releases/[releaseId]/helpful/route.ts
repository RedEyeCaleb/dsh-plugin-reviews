/** 整合包版本的「有帮助」投票。 */
import { getDb } from '@/server/platform/db';
import { createPacksService } from '@/server/modules/packs';
import { currentContext, okJson, errorResponse, requestMeta } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ releaseId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { releaseId } = await params;
    const ctx = await currentContext();
    const service = createPacksService({ db: getDb() });
    const result = await service.helpfulStateForRelease(releaseId, ctx.userId);
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ releaseId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { releaseId } = await params;
    const ctx = await currentContext();
    const service = createPacksService({ db: getDb() });
    const result = await service.toggleHelpfulForRelease(ctx, releaseId);
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
