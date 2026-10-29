/** 作者提交整合包版本审核（不依赖上传文件）。 */
import { getDb } from '@/server/platform/db';
import { createPacksService } from '@/server/modules/packs';
import { currentContext, okJson, errorResponse, requestMeta } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ releaseId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { releaseId } = await params;
    const ctx = await currentContext();
    const service = createPacksService({ db: getDb() });
    const result = await service.submitReleaseForReview(ctx, releaseId);
    if (result.outcome === 'verifying') {
      // 异步核验：不阻塞响应；失败保持「待审核」，由人工接手。
      void service.verifyPendingChecks(releaseId).catch((error: unknown) => {
        console.error('[pack-install-check] 核验失败', error);
      });
    }
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
