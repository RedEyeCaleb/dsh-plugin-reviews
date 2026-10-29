/**
 * 鉴权顺序回归（接口层）：**先认人，再读 body**。
 *
 * 起因：`POST /api/me/favorites/batch` 与 `POST /api/admin/pack-appeals/{appealId}`
 * 都是先 `readJson` 后鉴权，于是"匿名 + 非法 body"会拿到 400（参数错），
 * 而正确语义是 401/403（没登录 / 没权限）。两者都不泄露数据，但会让调用方
 * 与前端正确处理分支失配：前端收到 400 会提示"参数有误"，而不是引导登录。
 *
 * 本用例钉的是**顺序**，不是文案：
 *  - 非法 body + 匿名 → 401/403（旧实现会是 400，必然变红）；
 *  - 非法 body + 已登录 → 仍然是 400（权限通过后 body 校验不能被跳过）；
 *  - 合法身份 + 合法 body → 进入服务层（用服务层自己的参数错误证明"确实走到那里"）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 会话 Cookie 的可变桩：读取时按当前值返回。 */
const auth = vi.hoisted(() => ({ token: null as string | null }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (auth.token === null ? undefined : { name, value: auth.token }),
  }),
}));

import { POST as batchFavorites } from '../src/app/api/me/favorites/batch/route';
import { POST as resolveAppeal } from '../src/app/api/admin/pack-appeals/[appealId]/route';
import { closeDb, type SqliteDatabase } from '../src/server/platform/db';
import { createIdentityService } from '../src/server/modules/identity';
import { createTestDb, insertUser, type TestDb } from './support/db';

let h: TestDb;
let db: SqliteDatabase;

beforeEach(() => {
  h = createTestDb();
  db = h.db;
  process.env.DSH_REVIEW_DB_PATH = h.file;
  closeDb();
  auth.token = null;
});

afterEach(() => {
  closeDb();
  h.cleanup();
  delete process.env.DSH_REVIEW_DB_PATH;
  auth.token = null;
});

/** 以指定用户开一个真实会话，并把它的明文凭证塞进 Cookie 桩。 */
async function signIn(userId: string): Promise<void> {
  const identity = createIdentityService({ db });
  const session = await identity.createSession(userId, Date.now());
  auth.token = session.token;
}

function postJson(body: unknown): Request {
  return new Request('https://review.test/api/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function appealParams(): { params: Promise<{ appealId: string }> } {
  return { params: Promise.resolve({ appealId: 'x' }) };
}

interface ErrorBody {
  ok: false;
  error: { code: string; message: string };
}

describe('收藏夹批量操作：先鉴权后读 body', () => {
  it('匿名 + 非法 body → 401（不是 400）', async () => {
    const res = await batchFavorites(postJson({ action: 'nope' }));
    const body = (await res.json()) as ErrorBody;
    expect(res.status).toBe(401);
    expect(body.error.code).toBe('unauthenticated');
  });

  it('匿名 + 合法 body → 401，且请求体解析不参与判定', async () => {
    const res = await batchFavorites(postJson({ action: 'remove', pluginIds: ['p1'] }));
    expect(res.status).toBe(401);
  });

  it('已登录 + 非法 body → 仍然 400（鉴权通过后 body 校验照旧）', async () => {
    await signIn(insertUser(db));
    const res = await batchFavorites(postJson({ action: 'nope' }));
    const body = (await res.json()) as ErrorBody;
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('input_invalid');
  });

  it('已登录 + 合法 body → 进入服务层（返回服务层的参数错误）', async () => {
    await signIn(insertUser(db));
    const res = await batchFavorites(postJson({ action: 'remove', pluginIds: [] }));
    const body = (await res.json()) as ErrorBody;
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('input_invalid');
    // 服务层文案：至少一个插件 —— 证明路由守卫没把正常请求挡在门外。
    expect(body.error.message).toContain('插件');
  });
});

describe('管理员处理申诉：先鉴权后读 body', () => {
  it('匿名 + 非法 body → 403（不是 400）', async () => {
    const res = await resolveAppeal(postJson({}), appealParams());
    const body = (await res.json()) as ErrorBody;
    expect(res.status).toBe(403);
    expect(body.error.code).toBe('forbidden');
  });

  it('普通用户 + 非法 body → 403', async () => {
    await signIn(insertUser(db, { role: 'user' }));
    const res = await resolveAppeal(postJson({}), appealParams());
    const body = (await res.json()) as ErrorBody;
    expect(res.status).toBe(403);
    expect(body.error.code).toBe('forbidden');
  });

  it('管理员 + 非法 body → 400（鉴权通过后 body 校验照旧）', async () => {
    await signIn(insertUser(db, { role: 'admin' }));
    const res = await resolveAppeal(postJson({}), appealParams());
    const body = (await res.json()) as ErrorBody;
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('input_invalid');
  });
});
