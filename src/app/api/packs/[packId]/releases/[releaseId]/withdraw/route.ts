/** 作者撤回已发布的整合包版本。 */
import { getDb } from '@/server/platform/db';
import { createPacksService } from '@/server/modules/packs';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ packId: string; releaseId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { packId, releaseId } = await params;
    const ctx = await currentContext();
    const body = (await readJson(request)) as { reason?: unknown };
    const service = createPacksService({ db: getDb() });
    const result = await service.withdrawRelease(
      ctx,
      packId,
      releaseId,
      typeof body.reason === 'string' ? body.reason : null,
    );
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
