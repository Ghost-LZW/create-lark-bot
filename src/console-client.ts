/**
 * Feishu Open Platform console client: given the Web session cookies, load a console
 * page to extract `window.csrfToken` (and the final origin — some tenants redirect the
 * console to open.larkoffice.com) and expose `postJson` / `postForm` for the internal
 * `/developers/v1/*` endpoints.
 *
 * Ported from botmux (https://github.com/deepcoldy/botmux, MIT)
 * src/setup/open-platform-automation.ts (createOpenPlatformApiClient,
 * openPlatformWebSessionExpired, openPlatformUnderReview, extractOpenPlatformSessionIdentity).
 */
import { MutableCookieJar, type StoredCookie } from './web-session.js';
import { asRecord, pickString, safeErrorMessage } from './util.js';

/** The person + tenant the cached console session belongs to. */
export interface WebSessionIdentity {
  /** Console user id (NOT an open_id; only meaningful to the console). */
  userId: string;
  userName: string;
  email?: string;
  tenantId: string;
  tenantName: string;
}

export type OpenPlatformPostJson = (path: string, body?: unknown) => Promise<unknown>;

export interface OpenPlatformApiClient {
  apiOrigin: string;
  postJson(path: string, body?: unknown): Promise<unknown>;
  /**
   * POST that is semantically idempotent (value-setting switches, read-only fetches):
   * gets the same transient-network retry budget as GET.
   */
  postJsonIdempotent(path: string, body?: unknown): Promise<unknown>;
  postForm(path: string, body: FormData): Promise<unknown>;
}

export type OpenPlatformClientResult =
  | { ok: true; client: OpenPlatformApiClient; identity?: WebSessionIdentity }
  | { ok: false; reason: 'missing_csrf' | 'network'; message: string };

export class OpenPlatformApiError extends Error {
  constructor(message: string, readonly payload: unknown, readonly status: number = 0) {
    super(message);
    this.name = 'OpenPlatformApiError';
  }
}

export function extractOpenPlatformCsrfToken(html: string): string | null {
  const match =
    html.match(/\bwindow\.csrfToken\s*=\s*(['"])([^'"]+)\1/) ??
    html.match(/\bcsrfToken\s*:\s*(['"])([^'"]+)\1/);
  return match?.[2] ?? null;
}

/** The console writes the signed-in user into `window.user = {...}`. */
export function extractOpenPlatformSessionIdentity(html: string): WebSessionIdentity | null {
  const marker = /\bwindow\.user\s*=\s*/g;
  const match = marker.exec(html);
  if (!match) return null;
  const json = extractBalancedJsonObject(html, match.index + match[0].length);
  if (!json) return null;
  let user: Record<string, unknown>;
  try {
    user = asRecord(JSON.parse(json));
  } catch {
    return null;
  }
  const userId = pickString(user, ['id', 'userId', 'user_id']);
  const userName = pickString(user, ['name', 'userName', 'user_name'])
    ?? pickString(asRecord(user.displayName), ['value']);
  const tenantId = pickString(user, ['tenantId', 'tenant_id']);
  const tenantName = pickString(asRecord(user.tenantDisplayName), ['value'])
    ?? pickString(user, ['tenantName', 'tenant_name']);
  if (!userId || !userName || !tenantId || !tenantName) return null;
  const email = pickString(user, ['email']);
  return { userId, userName, ...(email ? { email } : {}), tenantId, tenantName };
}

export interface CreateClientOptions {
  fetchImpl?: typeof fetch;
  /**
   * Bind the client to one app: the CSRF seed page is `/app/<appId>/auth` (falling back to
   * the app home) and the referer is the app home — the same shape the console uses when
   * editing that app. Without it the client is generic (`/app`) and can call any app.
   */
  appId?: string;
}

export async function createOpenPlatformApiClient(
  cookies: StoredCookie[],
  opts: CreateClientOptions = {},
): Promise<OpenPlatformClientResult> {
  const fetcher = opts.fetchImpl ?? fetch;
  const session = new MutableCookieJar(cookies);
  let csrfToken: string | null = null;
  let apiOrigin = 'https://open.feishu.cn';
  let referer = `${apiOrigin}/app`;
  let identity: WebSessionIdentity | undefined;
  try {
    if (opts.appId) {
      const authPage = await session.fetchTextWithUrl(fetcher, `${apiOrigin}/app/${opts.appId}/auth`);
      apiOrigin = new URL(authPage.finalUrl).origin;
      referer = `${apiOrigin}/app/${opts.appId}`;
      csrfToken = extractOpenPlatformCsrfToken(authPage.text);
      identity = extractOpenPlatformSessionIdentity(authPage.text) ?? undefined;
      if (!csrfToken) {
        const home = await session.fetchTextWithUrl(fetcher, referer);
        apiOrigin = new URL(home.finalUrl).origin;
        referer = `${apiOrigin}/app/${opts.appId}`;
        csrfToken = extractOpenPlatformCsrfToken(home.text);
        identity ??= extractOpenPlatformSessionIdentity(home.text) ?? undefined;
      }
    } else {
      const page = await session.fetchTextWithUrl(fetcher, `${apiOrigin}/app`);
      apiOrigin = new URL(page.finalUrl).origin;
      referer = page.finalUrl;
      csrfToken = extractOpenPlatformCsrfToken(page.text);
      identity = extractOpenPlatformSessionIdentity(page.text) ?? undefined;
    }
  } catch (err) {
    return { ok: false, reason: 'network', message: `读取开放平台页面失败: ${safeErrorMessage(err)}` };
  }
  if (!csrfToken) {
    return {
      ok: false,
      reason: 'missing_csrf',
      message: '开放平台页面没有返回 window.csrfToken；Web session 可能已过期或未完成开放平台登录',
    };
  }

  const request = async (
    path: string,
    body: BodyInit | undefined,
    contentType: string | undefined,
    reqOpts: { idempotent?: boolean } = {},
  ): Promise<unknown> => {
    const response = await session.fetchRaw(fetcher, `${apiOrigin}${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: apiOrigin,
        referer,
        'x-csrf-token': csrfToken!,
        ...(contentType ? { 'content-type': contentType } : {}),
      },
      body,
    }, 10, reqOpts);
    let data: any;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      throw new OpenPlatformApiError(`HTTP ${response.status} ${path}: ${summarizePayload(data)}`, data, response.status);
    }
    if (data && typeof data === 'object' && typeof data.code === 'number' && data.code !== 0) {
      throw new OpenPlatformApiError(`code=${data.code} msg=${data.msg ?? data.message ?? ''}`, data, response.status);
    }
    return data;
  };
  const json = (body: unknown) => (body === undefined ? undefined : JSON.stringify(body));
  const ct = (body: unknown) => (body === undefined ? undefined : 'application/json');

  return {
    ok: true,
    identity,
    client: {
      apiOrigin,
      postJson: (path, body) => request(path, json(body), ct(body)),
      postJsonIdempotent: (path, body) => request(path, json(body), ct(body), { idempotent: true }),
      postForm: (path, body) => request(path, body, undefined),
    },
  };
}

/**
 * The console session was logged out server-side. The `/app` page may still render a
 * csrf token while the management APIs answer HTTP 400 + code=99991641 with
 * `error.Code=4101` / `LogoutReason=40` / "please log in again". Callers should offer a
 * fresh QR login (forceQrLogin) instead of retrying with the same cookies.
 */
export function openPlatformWebSessionExpired(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof OpenPlatformApiError) {
      if (current.status === 401) return true;
      const payload = asRecord(current.payload);
      const detail = asRecord(payload.error);
      const codes = [payload.code, detail.Code, detail.code];
      if (codes.some(code => Number(code) === 4101)) return true;
      if (Number(payload.code) === 99991641 && Number(detail.LogoutReason ?? detail.logoutReason) === 40) return true;
      const messages = [current.message, payload.msg, payload.message, detail.msg, detail.message]
        .filter((value): value is string => typeof value === 'string')
        .join(' ');
      if (/please\s+log\s+in\s+again|请重新登录/i.test(messages)) return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/** The signed-in console account is not a collaborator of this app (403 + code=10003). */
export function openPlatformOwnerAccessDenied(error: unknown): boolean {
  if (!(error instanceof OpenPlatformApiError)) return false;
  return error.status === 403 && asRecord(error.payload).code === 10003;
}

/**
 * `code=10046`: a version is under review and the whole app configuration is write-locked
 * (scope/update, robot/switch, safe_setting/update, base_info all refused; reads still work).
 * It heals itself once the review finishes — it is not a configuration error.
 */
export function openPlatformUnderReview(error: unknown): boolean {
  if (!(error instanceof OpenPlatformApiError)) return false;
  return asRecord(error.payload).code === 10046;
}

function summarizePayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return String(payload);
  const record = payload as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ['code', 'msg', 'message', 'error', 'error_msg']) {
    if (record[key] !== undefined) summary[key] = record[key];
  }
  return JSON.stringify(summary).slice(0, 500);
}

function extractBalancedJsonObject(input: string, start: number): string | null {
  if (input[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < input.length; i += 1) {
    const char = input[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  return null;
}
