/**
 * Resolve the scanning user's identity THROUGH THE NEW APP (official contact API, tenant token).
 *
 * An `ou_` open_id is app-scoped: it only means something to the app that issued it, and a
 * value the app cannot resolve must never be treated as a verified owner. union_id is stable
 * across the developer's apps and is what owner allow-lists should store.
 *
 * Inputs by path:
 *  - SDK device flow: the scanner's open_id (from `user_info.open_id`)
 *  - console path: the console session's email (when the console exposes one)
 *
 * Requires `contact:user.base:readonly` (open_id lookup) and `contact:user.id:readonly`
 * (email → id); both are in the `contact` preset. Right after creation the scopes may still be
 * propagating — the result then says `unverified`/`unresolved` with a reason, never guesses.
 *
 * Ported in spirit from botmux src/setup/owner-identity.ts (resolveScannerAllowedUser,
 * resolveSessionEmailAllowedUser), using fetch instead of the SDK client.
 */
import type { RegisterBrand } from './register-app.js';
import { asRecord, pickString, safeErrorMessage } from './util.js';
import { validateCredentials } from './validate.js';

export interface OwnerIdentity {
  /** Stable across the developer's apps. Present only when verified through the app. */
  unionId?: string;
  /** App-scoped id. May be present but unverified (see `verified.openId`). */
  openId?: string;
  email?: string;
  name?: string;
  verified: { unionId: boolean; openId: boolean };
  source: 'scan_open_id' | 'session_email' | 'none';
  /** verified: union_id confirmed by the app; unverified: only an unconfirmed open_id/email; unresolved: nothing usable. */
  status: 'verified' | 'unverified' | 'unresolved';
  /** Why it is not verified. */
  reason?: string;
}

export interface ResolveOwnerOptions {
  appId: string;
  appSecret: string;
  brand?: RegisterBrand;
  openId?: string;
  email?: string;
  name?: string;
  fetchImpl?: typeof fetch;
  /** Reuse a tenant token you already have. */
  tenantAccessToken?: string;
}

function openApiOrigin(brand: RegisterBrand | undefined): string {
  return brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

export async function resolveOwnerIdentity(opts: ResolveOwnerOptions): Promise<OwnerIdentity> {
  const fetcher = opts.fetchImpl ?? fetch;
  const origin = openApiOrigin(opts.brand);
  const openIdInput = opts.openId?.startsWith('ou_') ? opts.openId : undefined;
  const base: OwnerIdentity = {
    ...(openIdInput ? { openId: openIdInput } : {}),
    ...(opts.email ? { email: opts.email } : {}),
    ...(opts.name ? { name: opts.name } : {}),
    verified: { unionId: false, openId: false },
    source: openIdInput ? 'scan_open_id' : opts.email ? 'session_email' : 'none',
    status: openIdInput || opts.email ? 'unverified' : 'unresolved',
  };
  if (!openIdInput && !opts.email) return { ...base, reason: '没有可用于解析的扫码人 open_id 或邮箱' };

  let token = opts.tenantAccessToken;
  if (!token) {
    const v = await validateCredentials(opts.appId, opts.appSecret, opts.brand ?? 'feishu', { fetchImpl: fetcher });
    if (!v.ok) return { ...base, reason: `取 tenant_access_token 失败: ${v.message}` };
    token = v.tenantAccessToken;
  }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' };

  try {
    if (openIdInput) {
      const res = await fetcher(`${origin}/open-apis/contact/v3/users/${encodeURIComponent(openIdInput)}?user_id_type=open_id`, { method: 'GET', headers });
      const body = asRecord(await res.json().catch(() => null));
      if (body.code !== 0) {
        return { ...base, reason: `通讯录查询被拒（code=${String(body.code ?? res.status)}${body.msg ? ` ${String(body.msg)}` : ''}）；确认应用已获 contact:user.base:readonly 且扫码人在应用可见范围内` };
      }
      const user = asRecord(asRecord(body.data).user);
      const unionId = pickString(user, ['union_id']);
      const confirmedOpenId = pickString(user, ['open_id']);
      const name = pickString(user, ['name']) ?? opts.name;
      if (!unionId) return { ...base, reason: '应用没有为该 open_id 解析出 union_id' };
      return {
        ...base,
        unionId,
        ...(name ? { name } : {}),
        // a clean answer for this exact open_id proves it belongs to the app
        verified: { unionId: true, openId: !confirmedOpenId || confirmedOpenId === openIdInput },
        status: 'verified',
      };
    }

    const lookup = async (idType: 'union_id' | 'open_id') => {
      const res = await fetcher(`${origin}/open-apis/contact/v3/users/batch_get_id?user_id_type=${idType}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ emails: [opts.email], include_resigned: false }),
      });
      const body = asRecord(await res.json().catch(() => null));
      if (body.code !== 0) throw new Error(`code=${String(body.code ?? res.status)}${body.msg ? ` ${String(body.msg)}` : ''}`);
      const list = asRecord(body.data).user_list;
      const hit = (Array.isArray(list) ? list : []).map(asRecord).find(u => typeof u.user_id === 'string' && u.user_id);
      return hit ? String(hit.user_id) : undefined;
    };
    const unionId = await lookup('union_id');
    if (!unionId) return { ...base, status: 'unresolved', reason: '该邮箱在应用可见范围内没有对应用户' };
    let openId: string | undefined;
    try {
      openId = await lookup('open_id');
    } catch {
      /* union_id is what matters */
    }
    return {
      ...base,
      unionId,
      ...(openId ? { openId } : {}),
      verified: { unionId: true, openId: Boolean(openId) },
      status: 'verified',
    };
  } catch (err) {
    return { ...base, reason: `通讯录查询失败: ${safeErrorMessage(err)}；确认应用已获 contact:user.id:readonly / contact:user.base:readonly` };
  }
}
