/**
 * 准入守卫单测：`src/guard.js` 的双 API 兼容 + 结构性围栏 + 「绝不抛」承诺，
 * 路由接线端到端（真 http server + 假 ctx），以及 `src/routes.js` 注册点的
 * route admission 回归钉。
 *
 * 背景（0.3.1 修复的根因）：dsh 0.2.2-rc.3 移除了 `connection.requestRejection`，
 * 换成 `admit(request)`（`{rejection}` 信封）。旧守卫直接调旧方法并在 try-catch
 * 之外——每个请求都抛 TypeError，宿主兜底成 HTTP 400 空 body，前端报「服务端
 * 返回了无法解析的响应」。这份测试把守卫的每一条决策都钉住：任何输入都不许
 * 抛异常。场景清单与 dsh-mcpserver-manager/tests/guard.test.js 对齐。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { isLoopbackHost, rejectionFor, structuralRejection } from '../src/guard.js';
import { SshSessionService } from '../src/sessions.js';
import { createFakeTransport } from '../src/transport.js';
import { registerRoutes } from '../src/routes.js';
import { createFakeCtx, mountRoutes, request } from './stubs/fake-services.mjs';

/**
 * 造一个最小 req：默认回环 Host，无 Origin/Referer。
 * @param {Record<string, string|undefined>} [headers] 追加/覆盖的请求头。
 * @returns {object} req。
 */
function reqFor(headers = {}) {
  return { method: 'GET', url: '/api/dsh-ssh/hosts', headers: { host: '127.0.0.1:4242', ...headers } };
}

/**
 * 新 API 形状的 ctx（dsh ≥0.2.2-rc.3：`admit` 返回 `{rejection}` 信封）。
 * @param {(req: object) => unknown} impl admit 实现。
 * @returns {object} ctx。
 */
const ctxWithAdmit = (impl) => ({ connection: { admit: impl } });

/**
 * 旧 API 形状的 ctx（<0.2.2-rc.3：`requestRejection` 返回裸状态码；与
 * fake-services.mjs / routes.test.js 的 mock 同形状，验证它们继续兼容）。
 * @param {(req: object) => unknown} impl requestRejection 实现。
 * @returns {object} ctx。
 */
const ctxWithLegacy = (impl) => ({ connection: { requestRejection: impl } });

describe('guard · 新 API：admit 信封', () => {
  it('无 rejection 字段 / undefined / null —— 放行（宿主已自己做过来源检查）', () => {
    assert.equal(rejectionFor(ctxWithAdmit(() => undefined), reqFor()), undefined);
    assert.equal(rejectionFor(ctxWithAdmit(() => ({ rejection: undefined })), reqFor()), undefined);
    assert.equal(rejectionFor(ctxWithAdmit(() => null), reqFor()), undefined);
  });

  it('401 / 403 —— 硬拒，返回原状态码', () => {
    assert.equal(rejectionFor(ctxWithAdmit(() => ({ rejection: 401 })), reqFor()), 401);
    assert.equal(rejectionFor(ctxWithAdmit(() => ({ rejection: 403 })), reqFor()), 403);
  });

  it('503 —— 视为无决策：落结构性围栏，回环请求放行', () => {
    assert.equal(rejectionFor(ctxWithAdmit(() => ({ rejection: 503 })), reqFor()), undefined);
  });

  it('503 + 非回环 Host —— 结构性 403', () => {
    assert.equal(rejectionFor(ctxWithAdmit(() => ({ rejection: 503 })), reqFor({ host: '10.9.8.7' })), 403);
  });

  it('非数字 rejection（合同外形状）—— 不放大成 5xx，按无决策处理', () => {
    assert.equal(rejectionFor(ctxWithAdmit(() => ({ rejection: '403' })), reqFor()), undefined);
    assert.equal(rejectionFor(ctxWithAdmit(() => ({ rejection: NaN })), reqFor()), undefined);
  });
});

describe('guard · 旧 API：requestRejection 裸状态码', () => {
  it('同样的四种结论', () => {
    assert.equal(rejectionFor(ctxWithLegacy(() => undefined), reqFor()), undefined);
    assert.equal(rejectionFor(ctxWithLegacy(() => 401), reqFor()), 401);
    assert.equal(rejectionFor(ctxWithLegacy(() => 403), reqFor()), 403);
    assert.equal(rejectionFor(ctxWithLegacy(() => 503), reqFor()), undefined);
  });

  it('503 + 非回环 Host —— 结构性 403', () => {
    assert.equal(rejectionFor(ctxWithLegacy(() => 503), reqFor({ host: '10.9.8.7' })), 403);
  });

  it('现有 mock 形状（fake-services.mjs 的 { requestRejection: () => undefined }）继续兼容', () => {
    assert.equal(rejectionFor({ connection: { requestRejection: () => undefined } }, reqFor()), undefined);
  });
});

describe('guard · 服务缺席与异常：任何路径都不抛', () => {
  it('connection 缺席 —— 只剩结构性围栏', () => {
    assert.equal(rejectionFor({}, reqFor()), undefined);
    assert.equal(rejectionFor({ connection: undefined }, reqFor()), undefined);
    assert.equal(rejectionFor({}, reqFor({ host: '10.9.8.7' })), 403);
  });

  it('ctx 是 null / 原始值 —— 不抛，按无决策', () => {
    assert.equal(rejectionFor(null, reqFor()), undefined);
    assert.equal(rejectionFor(42, reqFor()), undefined);
  });

  it('ctx.connection 读取本身抛错（cordis Proxy 形状再变）—— 不抛', () => {
    const ctx = { get connection() { throw new Error('service registry not ready'); } };
    assert.equal(rejectionFor(ctx, reqFor()), undefined);
    assert.equal(rejectionFor(ctx, reqFor({ host: '10.9.8.7' })), 403);
  });

  it('admit 抛错 —— 视为无决策，落结构性围栏', () => {
    const ctx = ctxWithAdmit(() => { throw new Error('provider exploded'); });
    assert.equal(rejectionFor(ctx, reqFor()), undefined);
    assert.equal(rejectionFor(ctx, reqFor({ host: '10.9.8.7' })), 403);
  });

  it('requestRejection 抛错 —— 同样不抛', () => {
    const ctx = ctxWithLegacy(() => { throw new Error('provider exploded'); });
    assert.equal(rejectionFor(ctx, reqFor()), undefined);
    assert.equal(rejectionFor(ctx, reqFor({ host: '10.9.8.7' })), 403);
  });
});

describe('guard · 结构性围栏（复刻宿主 isTrustedApiRequest）', () => {
  it('非回环 Host / 缺 Host —— 403 host-not-loopback', () => {
    assert.equal(structuralRejection(reqFor({ host: '10.9.8.7' })), 403);
    assert.equal(structuralRejection(reqFor({ host: undefined })), 403);
  });

  it('sec-fetch-site: cross-site —— 403', () => {
    assert.equal(structuralRejection(reqFor({ 'sec-fetch-site': 'cross-site' })), 403);
  });

  it('同站 / 同源 / none 标记不拒', () => {
    assert.equal(structuralRejection(reqFor({ 'sec-fetch-site': 'same-origin' })), undefined);
    assert.equal(structuralRejection(reqFor({ 'sec-fetch-site': 'same-site' })), undefined);
    assert.equal(structuralRejection(reqFor({ 'sec-fetch-site': 'none' })), undefined);
  });

  it('Origin 与 Host authority 不一致 —— 403（主机 / 端口 / scheme 各来一遍）', () => {
    assert.equal(structuralRejection(reqFor({ origin: 'http://evil.example' })), 403);
    assert.equal(structuralRejection(reqFor({ origin: 'http://127.0.0.1:9999' })), 403);
    assert.equal(structuralRejection(reqFor({ origin: 'https://127.0.0.1:4242' })), 403);
  });

  it('同源 Origin / Referer —— 放行', () => {
    assert.equal(structuralRejection(reqFor({ origin: 'http://127.0.0.1:4242' })), undefined);
    assert.equal(structuralRejection(reqFor({ referer: 'http://127.0.0.1:4242/page' })), undefined);
  });

  it('Referer 与 Host 不一致 —— 403 referer-mismatch', () => {
    assert.equal(structuralRejection(reqFor({ referer: 'http://evil.example/x' })), 403);
  });

  it('Origin 不是可解析的 authority —— 403 origin-invalid', () => {
    assert.equal(structuralRejection(reqFor({ origin: '::garbage::' })), 403);
  });

  it('完全无 Origin/Referer 的回环请求 —— 放行（curl / 桌面端探测的正常形态）', () => {
    assert.equal(structuralRejection(reqFor()), undefined);
  });

  it('::1：带方括号的 Host 头放行；isLoopbackHost 认裸拼写', () => {
    assert.equal(structuralRejection(reqFor({ host: '[::1]:4242' })), undefined);
    assert.equal(structuralRejection(reqFor({ host: 'localhost:3000' })), undefined);
    assert.equal(isLoopbackHost('::1'), true);
    assert.equal(isLoopbackHost('[::1]'), true);
    assert.equal(isLoopbackHost('localhost:8080'), true);
    assert.equal(isLoopbackHost('10.0.0.1'), false);
    assert.equal(isLoopbackHost(''), false);
  });

  it('Host 头是裸 ::1（不合规范的拼写，浏览器都带方括号）—— 拒（忠实复刻宿主判定）', () => {
    assert.equal(structuralRejection(reqFor({ host: '::1' })), 403);
  });
});

describe('guard · desktop-relay Referer 特例', () => {
  const RELAY = 'dsh-app://app/index.html';

  it('只有 dsh-app://app Referer（桌面端 forwardWebRequest 转发形态）—— 放行', () => {
    assert.equal(structuralRejection(reqFor({ referer: RELAY })), undefined);
  });

  it('与 Origin 或 sec-fetch-site 共存 —— 403（特例不是通行证）', () => {
    assert.equal(structuralRejection(reqFor({ referer: RELAY, origin: 'http://127.0.0.1:4242' })), 403);
    assert.equal(structuralRejection(reqFor({ referer: RELAY, 'sec-fetch-site': 'same-origin' })), 403);
  });

  it('非 app 主机的 dsh-app:// Referer —— 走普通 referer 校验，403 referer-invalid', () => {
    assert.equal(structuralRejection(reqFor({ referer: 'dsh-app://evil/x' })), 403);
  });

  it('特例只影响结构性检查，永不推翻 connection 的硬拒', () => {
    assert.equal(
      rejectionFor(ctxWithAdmit(() => ({ rejection: 403 })), reqFor({ referer: RELAY })),
      403,
    );
  });
});

describe('guard · onRejection 诊断回调', () => {
  it('硬拒时收到固定字段决策；回调抛错不影响决策', () => {
    /** @type {Array<{status: number, source: string, reason: string}>} */
    const seen = [];
    const status = rejectionFor(
      ctxWithAdmit(() => ({ rejection: 401 })),
      reqFor(),
      (decision) => {
        seen.push(decision);
        throw new Error('logger blew up');
      },
    );
    assert.equal(status, 401);
    assert.deepEqual(seen, [{ status: 401, source: 'connection', reason: 'host-rejected' }]);
  });

  it('结构性硬拒的 decision 带 source=structural 与固定原因码', () => {
    /** @type {Array<{status: number, source: string, reason: string}>} */
    const seen = [];
    const status = rejectionFor({}, reqFor({ host: '10.9.8.7' }), (decision) => seen.push(decision));
    assert.equal(status, 403);
    assert.deepEqual(seen, [{ status: 403, source: 'structural', reason: 'host-not-loopback' }]);
  });

  it('放行时不回调', () => {
    let calls = 0;
    rejectionFor(ctxWithAdmit(() => undefined), reqFor(), () => { calls += 1; });
    assert.equal(calls, 0);
  });
});

describe('guard · routes.js 接线（端到端，真 http server + 假 ctx）', () => {
  /**
   * 挂一套最小路由栈：假 ctx + fake transport 的 service + 真 http server。
   * @param {(req: object) => unknown|undefined} [admitImpl] connection 服务的
   *   `admit` 实现；缺省 = 不换 connection（stub 默认是旧 API 形状）。
   * @returns {Promise<{baseUrl: string, close: () => Promise<void>}>} 服务器句柄。
   */
  async function mount(admitImpl = undefined) {
    const service = new SshSessionService({ createTransport: createFakeTransport });
    const ctx = createFakeCtx();
    if (admitImpl !== undefined) ctx.connection = { admit: admitImpl };
    registerRoutes(ctx, { service });
    const server = await mountRoutes(ctx);
    return { baseUrl: server.baseUrl, close: server.close };
  }

  it('宿主是新版（connection 只有 admit）—— GET /llm 正常 200 JSON，不再 TypeError→400', async () => {
    const own = await mount(() => undefined);
    try {
      const res = await request(`${own.baseUrl}/api/dsh-ssh/llm`);
      assert.equal(res.status, 200);
      assert.equal(res.json.available, false, 'llm 未挂载是可回答状态（available:false），不是 4xx/5xx');
    } finally {
      await own.close();
    }
  });

  it('admit 硬拒 403 —— 403 空 body（沿用守卫语义，不走错误信封）', async () => {
    const own = await mount(() => ({ rejection: 403 }));
    try {
      const res = await request(`${own.baseUrl}/api/dsh-ssh/llm`);
      assert.equal(res.status, 403);
      assert.equal(res.text, '');
    } finally {
      await own.close();
    }
  });

  it('admit 回 503 —— 视为无决策，匿名路由落结构性围栏后放行（200）', async () => {
    const own = await mount(() => ({ rejection: 503 }));
    try {
      const res = await request(`${own.baseUrl}/api/dsh-ssh/llm`);
      assert.equal(res.status, 200);
      assert.equal(res.json.available, false);
    } finally {
      await own.close();
    }
  });

  it('旧 API（stub 默认 requestRejection）—— 放行路径不受影响', async () => {
    const own = await mount();
    try {
      const res = await request(`${own.baseUrl}/api/dsh-ssh/llm`);
      assert.equal(res.status, 200);
      assert.equal(res.json.available, false);
    } finally {
      await own.close();
    }
  });
});

describe('routes · route admission（dsh 0.2.2-rc.3 回归钉）', () => {
  const source = readFileSync(new URL('../src/routes.js', import.meta.url), 'utf8');

  // dsh 0.2.2-rc.3 起 `webServer.register` 默认 `auth: 'required'`：没声明的
  // 路由在到达插件 handler 之前就被宿主判 503 `admission unavailable`（非
  // JSON 体），前端解析不了。这里钉住注册点必须显式 anonymous，把准入交回
  // 包装里的 `rejected` 守卫。
  it('唯一的 webServer.register 注册点显式声明 auth: anonymous', () => {
    // 懒惰匹配到第一个 `}),`：包装 handler 体内只会出现 `},`，所以第一个
    // `}),` 就是 register 调用自身的收尾——调用边界不依赖缩进。
    const registrations = [...source.matchAll(/ctx\.webServer\.register\(\{[\s\S]*?\}\),/g)]
      .map((match) => match[0]);
    assert.equal(
      registrations.length,
      1,
      '注册点必须恰好 1 处（全部路由走同一个 register 包装，SSE/transfer/chat 类长连接也不例外）；若新增了注册点，每处都要声明 anonymous',
    );
    for (const registration of registrations) {
      assert.match(
        registration,
        /auth:\s*'anonymous'/,
        `路由必须声明 auth: 'anonymous'，否则新版宿主默认 required 会返回 503：${registration.slice(0, 120)}`,
      );
    }
  });
});
