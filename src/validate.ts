/**
 * 凭证校验：用 AppID/Secret 取一次 `tenant_access_token`，通过即认为凭证有效。
 * Secret 永远不进错误信息；带总超时，网络半挂不会无限卡住。
 */
import type { RegisterBrand } from './register-app.js';

export type CredentialValidation =
  | { ok: true; tenantAccessToken: string; tokenExpiresIn: number }
  | { ok: false; error: 'invalid_credentials' | 'network' | 'unknown'; message: string };

function openApiOrigin(brand: RegisterBrand): string {
  return brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

export async function validateCredentials(
  appId: string,
  appSecret: string,
  brand: RegisterBrand = 'feishu',
  opts: { budgetMs?: number; signal?: AbortSignal } = {},
): Promise<CredentialValidation> {
  const budgetMs = opts.budgetMs ?? 10_000;
  const url = `${openApiOrigin(brand)}/open-apis/auth/v3/tenant_access_token/internal`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), budgetMs);
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
  }

  // timer 覆盖到 res.json() 之后——服务端 body 半 chunk 挂起时也能超时退出。
  let res: Response;
  let body: any;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 这是飞书唯一接受 appSecret 的端点; 不要把 secret 拼进 query string 或日志。
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: ac.signal,
    });
    body = await res.json();
  } catch (err: any) {
    clearTimeout(timer);
    const isAbort = err?.name === 'AbortError' || ac.signal.aborted;
    if (!isAbort && err instanceof SyntaxError) {
      return { ok: false, error: 'unknown', message: `HTTP ${res!?.status ?? '?'} 响应非 JSON` };
    }
    return {
      ok: false,
      error: 'network',
      message: isAbort ? `请求超时 (> ${budgetMs}ms)` : `网络错误: ${err?.code ?? err?.message ?? 'unknown'}`,
    };
  }
  clearTimeout(timer);

  if (body?.code === 0 && typeof body.tenant_access_token === 'string') {
    return { ok: true, tenantAccessToken: body.tenant_access_token, tokenExpiresIn: body.expire ?? 7200 };
  }

  // 飞书常见错误码: 10003/10012 app_id 或 secret 无效; 99991663 secret 无效
  if (body?.code === 10003 || body?.code === 10012 || body?.code === 99991663) {
    return { ok: false, error: 'invalid_credentials', message: `凭证无效 (code=${body.code}): ${body.msg ?? ''}` };
  }

  return { ok: false, error: 'unknown', message: `code=${body?.code ?? '?'} msg=${body?.msg ?? ''}` };
}
