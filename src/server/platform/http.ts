/**
 * 出网小工具：只给「安装资料核验」用。
 *
 * 约束：超时、不让第三方返回体撑爆内存、错误统一成 { ok, status, body }，
 * 调用方据此判断，不抛异常打断请求链路。
 */

export interface HttpResult {
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 8000;

export async function getJson(
  url: string,
  init: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'user-agent': 'dsh-plugin-reviews/1.0', accept: 'application/json', ...init.headers },
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text.length > 0 ? (JSON.parse(text) as unknown) : null;
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
