/**
 * 创建整合包并发布第 1 版（`idea.md` §26；C 路线：入口沿用「从收藏夹创建」）。
 *
 * 请求体是 `ReleaseInput`（见 `modules/packs`）：
 *   title / purpose / bodyMarkdown / dshVersion / configTemplate / testStatus / testTask /
 *   testResult / items[]
 *
 * 每条 item 只接受**结构化** installTarget —— 命令由服务端适配器生成，
 * 客户端传命令文本没有意义（也不会被采用）。
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { enforceRateLimit, refundQuietly, RATE_LIMIT_RULES } from '@/server/platform/rate-limit';
import { rateLimitOverrideFor } from '@/server/modules/settings';
import { createPacksService, type ReleaseInput } from '@/server/modules/packs';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../_lib/context';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    assertCanWrite(ctx);

    const body = (await readJson(request)) as Partial<ReleaseInput>;
    if (body === null || typeof body !== 'object') {
      throw err.input('请求体必须是对象。', [{ path: '', message: '格式不合法' }]);
    }

    const db = getDb();
    // 创建整合包会写多张表并分配版本序号：按「提交类」动作限速（默认 10 次/时）。
    const ticket = await enforceRateLimit(
      db,
      'plugin_submission',
      ctx.userId,
      1,
      await rateLimitOverrideFor(db, RATE_LIMIT_RULES.plugin_submission),
    );

    try {
      const service = createPacksService({ db });
      // 创建即草稿：作者上传整合包文件后进入待审核，审核通过才公开。
      const result = await service.createPackDraft(ctx, body as ReleaseInput);
      return okJson(result, requestId, 201);
    } catch (e) {
      await refundQuietly(ticket);
      throw e;
    }
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
