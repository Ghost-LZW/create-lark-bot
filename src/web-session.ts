/**
 * 飞书 Web QR 登录态管理（整个流程唯一的一次扫码）。
 *
 * 直接实现飞书 Web 扫码登录：`accounts.feishu.cn/accounts/qrlogin/init` 初始化
 * → 终端渲染二维码 → 轮询 `/accounts/qrlogin/polling` → 跟随 cross-login URI
 * → 把 cookie jar 私有落盘（0600，目录 0700）。落盘后的 session 可复用——同一台机器
 * 再建 bot 时 0 扫码。
 *
 * 实现源自 botmux（https://github.com/deepcoldy/botmux，MIT）的
 * src/setup/open-platform-automation.ts。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import qrcode from 'qrcode-terminal';
import { asRecord, pickString, safeErrorMessage, sleep, uniqueStrings } from './util.js';

// Re-exported for backward compatibility (these used to live here).
export { asRecord, pickString, safeErrorMessage, uniqueStrings };

const FEISHU_ACCOUNTS_ORIGIN = 'https://accounts.feishu.cn';
const SESSION_PROBE_ORIGIN = 'https://ask.feishu.cn';
const FEISHU_APP_ID = '12';
const FEISHU_COMMON_HEADERS = {
  'x-api-version': '1.0.28',
  'x-device-info':
    'device_id=0;device_name=Chrome;device_os=Mac;device_model=Chrome;lark_version=;channel=Release;package_name=feishu;tt_app_id=1658;is_dpop_support=true;is_iframe=false',
  'x-locale': 'zh-CN',
  'x-terminal-type': '2',
};

export const DEFAULT_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  hostOnly: boolean;
  expiresAt?: number;
  sameSite?: string;
}

export type WebSessionSource = 'cache' | 'qr_login' | 'fallback_file';
export type WebSessionFailureReason = 'login_failed' | 'qr_expired' | 'timeout' | 'network' | 'invalid_session';

export type WebSessionPrepareResult =
  | {
      ok: true;
      sessionFile: string;
      source: WebSessionSource;
      cookies: StoredCookie[];
      cookieCount: number;
    }
  | {
      ok: false;
      reason: WebSessionFailureReason;
      message: string;
      sessionFile: string;
    };

export interface WebSessionOptions {
  /** session 落盘路径，默认 `~/.lark-bot/web-session.json`。 */
  sessionFilePath?: string;
  /** QR 登录失败后按顺序尝试读取的额外 session 文件（如其它工具留下的登录态）。 */
  fallbackSessionFiles?: string[];
  /** 忽略缓存，强制重新扫码（换账号 / 登录态半失效时用）。 */
  forceQrLogin?: boolean;
  /** 只复用有效缓存；没有就失败，绝不弹二维码（脚本 / 非 TTY 场景）。 */
  disableQrLogin?: boolean;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  onQrCode?: (info: { qrText: string; qrPayload: string }) => void | Promise<void>;
  /** 本次二维码被扫（飞书报 status=2）时触发一次。 */
  onQrScanConfirmed?: (info: { confirmedAt: number }) => void | Promise<void>;
  onStatus?: (message: string) => void | Promise<void>;
}

export function defaultSessionFilePath(configDir = join(homedir(), '.lark-bot')): string {
  return join(configDir, 'web-session.json');
}

export function readStoredCookiesFromSessionFile(filePath: string): StoredCookie[] | null {
  if (!existsSync(filePath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const cookies = (parsed as { cookies?: unknown }).cookies;
  if (!Array.isArray(cookies)) return null;
  return pruneExpiredCookies(cookies.filter(isStoredCookieRecord));
}

export function writeStoredCookiesToSessionFile(filePath: string, cookies: StoredCookie[]): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort on non-POSIX filesystems.
  }
  const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmpPath, JSON.stringify({ cookies: pruneExpiredCookies(cookies) }, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    renameSync(tmpPath, filePath);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore.
    }
  }
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on non-POSIX filesystems.
  }
}

export function getCookieHeader(cookies: StoredCookie[], requestUrl: string): string {
  const url = new URL(requestUrl);
  return pruneExpiredCookies(cookies)
    .filter(cookie => {
      if (cookie.secure && url.protocol !== 'https:') return false;
      if (!domainMatches(url.hostname, cookie)) return false;
      return pathMatches(url.pathname || '/', cookie.path || '/');
    })
    .sort((a, b) => b.path.length - a.path.length)
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

export function buildQrLoginPayload(token: string): string {
  return JSON.stringify({ qrlogin: { token } });
}

export function mapQrPollingStatus(status: number | null): string {
  if (status === 2) return '已经扫码，等待手机确认';
  if (status === 5) return '二维码已过期';
  return '等待飞书扫码';
}

/**
 * 获取可用的飞书 Web session：缓存有效 → 直接复用（0 扫码）；否则终端二维码
 * 扫码登录；仍失败时按序尝试 fallback session 文件。
 */
export async function prepareWebSession(options: WebSessionOptions = {}): Promise<WebSessionPrepareResult> {
  const fetcher = options.fetchImpl ?? fetch;
  const sessionFile = options.sessionFilePath ?? defaultSessionFilePath();
  if (!options.forceQrLogin) {
    const cached = readStoredCookiesFromSessionFile(sessionFile);
    if (cached && cached.length > 0 && (await validateWebSession(cached, fetcher))) {
      return { ok: true, sessionFile, source: 'cache', cookies: cached, cookieCount: cached.length };
    }
  }
  if (options.disableQrLogin) {
    return {
      ok: false,
      reason: 'invalid_session',
      message: '没有可复用的飞书 Web session；已按要求不弹二维码',
      sessionFile,
    };
  }

  let loginError: unknown;
  try {
    const loggedIn = await loginWebSession(fetcher, options);
    writeStoredCookiesToSessionFile(sessionFile, loggedIn);
    return { ok: true, sessionFile, source: 'qr_login', cookies: loggedIn, cookieCount: loggedIn.length };
  } catch (err) {
    loginError = err;
  }

  for (const fallbackFile of options.forceQrLogin ? [] : options.fallbackSessionFiles ?? []) {
    const fallback = readStoredCookiesFromSessionFile(fallbackFile);
    if (fallback && fallback.length > 0 && (await validateWebSession(fallback, fetcher))) {
      writeStoredCookiesToSessionFile(sessionFile, fallback);
      return { ok: true, sessionFile, source: 'fallback_file', cookies: fallback, cookieCount: fallback.length };
    }
  }

  return {
    ok: false,
    reason: classifyLoginError(loginError),
    message: safeErrorMessage(loginError),
    sessionFile,
  };
}

export async function validateWebSession(cookies: StoredCookie[], fetcher: typeof fetch = fetch): Promise<boolean> {
  if (cookies.length === 0) return false;
  const session = new MutableCookieJar(cookies);
  try {
    const response = await session.fetchRaw(fetcher, `${SESSION_PROBE_ORIGIN}/`, { method: 'GET' });
    if (!response.ok) return false;
    const text = await response.text();
    return !isLoginLikeValue(text);
  } catch {
    return false;
  }
}

async function loginWebSession(fetcher: typeof fetch, options: WebSessionOptions): Promise<StoredCookie[]> {
  const session = new MutableCookieJar([]);
  const redirectUrl = `${SESSION_PROBE_ORIGIN}/`;
  const qrInit = await initQrLogin(session, fetcher, redirectUrl);
  const qrPayload = buildQrLoginPayload(qrInit.token);
  const qrText = await renderTerminalQr(qrPayload);
  const onQrCode = options.onQrCode ?? defaultPrintQrCode;
  await onQrCode({ qrText, qrPayload });

  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const maxWaitMs = options.maxWaitMs ?? 120_000;
  const start = Date.now();
  let lastStatusMessage = '';
  let scanConfirmed = false;
  for (;;) {
    if (Date.now() - start > maxWaitMs) {
      throw new WebSessionError('等待飞书扫码超时', 'timeout');
    }

    const poll = await pollQrLogin(session, fetcher, qrInit.flowKey);
    if (poll.status === 2 && !scanConfirmed) {
      scanConfirmed = true;
      await options.onQrScanConfirmed?.({ confirmedAt: Date.now() });
    }
    if (poll.nextStep === 'enter_app') {
      if (poll.crossLoginUri) {
        await session.fetchRaw(fetcher, poll.crossLoginUri, { method: 'GET' });
      }
      await session.fetchRaw(fetcher, redirectUrl, { method: 'GET' });
      const cookies = session.toJSON();
      if (!(await validateWebSession(cookies, fetcher))) {
        throw new WebSessionError('飞书扫码已完成，但没有拿到可复用的 Web session', 'invalid_session');
      }
      return cookies;
    }

    const statusMessage = mapQrPollingStatus(poll.status);
    if (options.onStatus && statusMessage !== lastStatusMessage) {
      lastStatusMessage = statusMessage;
      await options.onStatus(statusMessage);
    }
    if (poll.status === 5) {
      throw new WebSessionError('二维码已过期', 'qr_expired');
    }
    await sleep(pollIntervalMs);
  }
}

async function initQrLogin(
  session: MutableCookieJar,
  fetcher: typeof fetch,
  authorizeUrl: string,
): Promise<{ flowKey: string; token: string }> {
  const endpoint = `${FEISHU_ACCOUNTS_ORIGIN}/accounts/qrlogin/init?_r${10000 + Math.floor(Math.random() * 80000)}=${Date.now()}`;
  const response = await session.fetchRaw(fetcher, endpoint, {
    method: 'POST',
    headers: {
      ...FEISHU_COMMON_HEADERS,
      'x-app-id': FEISHU_APP_ID,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ biz_type: null, redirect_uri: authorizeUrl }),
  });
  const data = await response.json();
  assertFeishuApiOk(data, 'Feishu QR init failed');
  const token = asRecord(asRecord(data).data).step_info
    ? pickString(asRecord(asRecord(asRecord(data).data).step_info), ['token'])
    : undefined;
  const flowKey = response.headers.get('x-flow-key') ?? '';
  if (!flowKey || !token) {
    throw new WebSessionError('Feishu QR init missing flow key or token', 'login_failed');
  }
  return { flowKey, token };
}

async function pollQrLogin(
  session: MutableCookieJar,
  fetcher: typeof fetch,
  flowKey: string,
): Promise<{ nextStep: string | null; status: number | null; crossLoginUri: string | null }> {
  const endpoint = `${FEISHU_ACCOUNTS_ORIGIN}/accounts/qrlogin/polling?_r${10000 + Math.floor(Math.random() * 80000)}=${Date.now()}`;
  const response = await session.fetchRaw(fetcher, endpoint, {
    method: 'POST',
    headers: {
      ...FEISHU_COMMON_HEADERS,
      'x-app-id': FEISHU_APP_ID,
      'x-flow-key': flowKey,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ biz_type: null }),
  });
  const data = await response.json();
  assertFeishuApiOk(data, 'Feishu QR polling failed');
  const payload = asRecord(asRecord(data).data);
  const stepInfo = asRecord(payload.step_info);
  return {
    nextStep: pickString(payload, ['next_step']) ?? null,
    status: typeof stepInfo.status === 'number' ? stepInfo.status : null,
    crossLoginUri: pickString(stepInfo, ['cross_login_uri']) ?? null,
  };
}

/** 带 cookie 跟随重定向的最小可变 cookie jar（Web session 请求全部经此发出）。 */
export class MutableCookieJar {
  private cookies: StoredCookie[];

  constructor(cookies: StoredCookie[]) {
    this.cookies = pruneExpiredCookies(cookies);
  }

  toJSON(): StoredCookie[] {
    this.cookies = pruneExpiredCookies(this.cookies);
    return this.cookies.map(cookie => ({ ...cookie }));
  }

  async fetchText(fetcher: typeof fetch, url: string): Promise<string> {
    const response = await this.fetchRaw(fetcher, url, { method: 'GET' });
    return await response.text();
  }

  async fetchTextWithUrl(fetcher: typeof fetch, url: string): Promise<{ text: string; finalUrl: string }> {
    const response = await this.fetchRaw(fetcher, url, { method: 'GET' });
    return {
      text: await response.text(),
      finalUrl: finalResponseUrl(response, url),
    };
  }

  /**
   * 带 cookie 跟随重定向。GET/HEAD 与调用方声明为幂等的 POST（`opts.idempotent`）
   * 对瞬态网络错误小步退避重试；其它 POST 只在「TLS 握手前断连」（可证明请求未送达）
   * 时重试——写操作重放可能重复提交。重试预算只在这一层（源自 botmux #913/#945/#1097）。
   */
  async fetchRaw(
    fetcher: typeof fetch,
    url: string,
    init: RequestInit = {},
    maxHops = 10,
    opts: { idempotent?: boolean } = {},
  ): Promise<Response> {
    let current = url;
    let referer: string | undefined;
    const method = (init.method ?? 'GET').toUpperCase();
    const retryable = opts.idempotent === true || method === 'GET' || method === 'HEAD';
    for (let hop = 0; hop <= maxHops; hop += 1) {
      const headers = new Headers(init.headers);
      const cookieHeader = getCookieHeader(this.cookies, current);
      if (cookieHeader) headers.set('cookie', cookieHeader);
      headers.set('user-agent', headers.get('user-agent') ?? DEFAULT_BROWSER_USER_AGENT);
      if (referer && !headers.has('referer')) headers.set('referer', referer);

      let response: Response;
      for (let attempt = 0; ; attempt += 1) {
        try {
          response = await fetcher(current, { ...init, headers, redirect: 'manual' });
          break;
        } catch (err) {
          const mayRetry = retryable ? isLikelyTransientNetworkError(err) : isProvablyUnsentTransportError(err);
          if (attempt >= TRANSIENT_FETCH_RETRY_DELAYS_MS.length || !mayRetry) throw err;
          await sleep(TRANSIENT_FETCH_RETRY_DELAYS_MS[attempt]);
        }
      }
      this.loadFromResponse(current, response.headers);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return response;
        referer = current;
        current = new URL(location, current).toString();
        continue;
      }
      markFinalResponseUrl(response, current);
      return response;
    }
    throw new Error('Too many redirects');
  }

  private loadFromResponse(responseUrl: string, headers: Headers): void {
    const rawSetCookies = typeof (headers as any).getSetCookie === 'function'
      ? (headers as any).getSetCookie()
      : splitSetCookieHeader(headers.get('set-cookie'));
    for (const raw of rawSetCookies) {
      const cookie = parseSetCookie(responseUrl, raw);
      if (!cookie) continue;
      const idx = this.cookies.findIndex(
        item => item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path,
      );
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= Date.now()) {
        if (idx >= 0) this.cookies.splice(idx, 1);
        continue;
      }
      if (idx >= 0) this.cookies[idx] = cookie;
      else this.cookies.push(cookie);
    }
    this.cookies = pruneExpiredCookies(this.cookies);
  }
}

export class WebSessionError extends Error {
  constructor(message: string, readonly reason: WebSessionFailureReason) {
    super(message);
  }
}

function defaultPrintQrCode(info: { qrText: string }): void {
  process.stderr.write('\n请用飞书 App 扫码登录飞书开放平台（创建 / 配置应用只需这一次）：\n\n');
  process.stderr.write(`${info.qrText}\n`);
}

async function renderTerminalQr(payload: string): Promise<string> {
  return await new Promise(resolve => qrcode.generate(payload, { small: true }, qr => resolve(qr)));
}

const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ENETUNREACH',
  'EHOSTUNREACH', 'ENETDOWN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);
const TRANSIENT_FETCH_RETRY_DELAYS_MS = [300, 900];
/** Node `_tls_wrap` 唯一产出此文案：TLS 握手完成前连接断开 ⟹ 应用层请求一个字节都没发出。 */
const PRE_TLS_DISCONNECT_MESSAGE =
  'Client network socket disconnected before secure TLS connection was established';

function isProvablyUnsentTransportError(err: unknown, depth = 0): boolean {
  if (depth > 4 || !(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  if (err instanceof AggregateError) return false;
  if ((err as { code?: unknown }).code === 'ECONNRESET' && err.message === PRE_TLS_DISCONNECT_MESSAGE) {
    return err.cause === undefined;
  }
  return isProvablyUnsentTransportError((err as { cause?: unknown }).cause, depth + 1);
}

function isLikelyTransientNetworkError(err: unknown, depth = 0): boolean {
  if (depth > 4 || !(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_NETWORK_ERROR_CODES.has(code)) return true;
  if (err instanceof AggregateError && err.errors.some(item => isLikelyTransientNetworkError(item, depth + 1))) {
    return true;
  }
  if (err instanceof TypeError && err.message === 'fetch failed') {
    return err.cause === undefined || isLikelyTransientNetworkError(err.cause, depth + 1);
  }
  return isLikelyTransientNetworkError((err as { cause?: unknown }).cause, depth + 1);
}

function assertFeishuApiOk(payload: unknown, message: string): void {
  const record = asRecord(payload);
  if (record.code === 0) return;
  const msg = pickString(record, ['message', 'msg']) ?? 'unknown error';
  throw new WebSessionError(`${message}: ${msg}`, 'login_failed');
}

function isLoginLikeValue(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes('/accounts/') || normalized.includes('/login') || normalized.includes('qrlogin');
}

function classifyLoginError(err: unknown): WebSessionFailureReason {
  if (err instanceof WebSessionError) return err.reason;
  const message = err instanceof Error ? err.message : String(err);
  if (/timeout|timed out|超时/i.test(message)) return 'timeout';
  if (/expired|过期/i.test(message)) return 'qr_expired';
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|network/i.test(message)) return 'network';
  return 'login_failed';
}

function isStoredCookieRecord(value: unknown): value is StoredCookie {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cookie = value as Partial<StoredCookie>;
  return typeof cookie.name === 'string'
    && typeof cookie.value === 'string'
    && typeof cookie.domain === 'string'
    && typeof cookie.path === 'string'
    && typeof cookie.secure === 'boolean'
    && typeof cookie.httpOnly === 'boolean'
    && typeof cookie.hostOnly === 'boolean';
}

function pruneExpiredCookies(cookies: StoredCookie[]): StoredCookie[] {
  const now = Date.now();
  return cookies.filter(cookie => cookie.expiresAt === undefined || cookie.expiresAt > now);
}

function domainMatches(hostname: string, cookie: StoredCookie): boolean {
  const host = hostname.toLowerCase();
  const domain = cookie.domain.replace(/^\./, '').toLowerCase();
  if (cookie.hostOnly) return host === domain;
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

function splitSetCookieHeader(header: string | null): string[] {
  if (!header) return [];
  const parts: string[] = [];
  let start = 0;
  let inExpires = false;
  for (let i = 0; i < header.length; i += 1) {
    const slice = header.slice(Math.max(0, i - 8), i + 1).toLowerCase();
    if (slice.endsWith('expires=')) inExpires = true;
    if (inExpires && header[i] === ';') inExpires = false;
    if (!inExpires && header[i] === ',') {
      parts.push(header.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(header.slice(start).trim());
  return parts.filter(Boolean);
}

function parseSetCookie(responseUrl: string, header: string): StoredCookie | null {
  const url = new URL(responseUrl);
  const parts = header.split(';').map(part => part.trim()).filter(Boolean);
  const first = parts.shift();
  if (!first) return null;
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const cookie: StoredCookie = {
    name: first.slice(0, eq),
    value: first.slice(eq + 1),
    domain: url.hostname,
    path: '/',
    secure: false,
    httpOnly: false,
    hostOnly: true,
  };
  for (const part of parts) {
    const partEq = part.indexOf('=');
    const key = (partEq >= 0 ? part.slice(0, partEq) : part).trim().toLowerCase();
    const value = partEq >= 0 ? part.slice(partEq + 1).trim() : '';
    if (key === 'domain' && value) {
      cookie.domain = value.toLowerCase();
      cookie.hostOnly = false;
    } else if (key === 'path' && value) {
      cookie.path = value;
    } else if (key === 'secure') {
      cookie.secure = true;
    } else if (key === 'httponly') {
      cookie.httpOnly = true;
    } else if (key === 'expires' && value) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) cookie.expiresAt = parsed;
    } else if (key === 'max-age' && value) {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) cookie.expiresAt = Date.now() + seconds * 1000;
    } else if (key === 'samesite' && value) {
      cookie.sameSite = value;
    }
  }
  return cookie;
}

function markFinalResponseUrl(response: Response, finalUrl: string): void {
  try {
    Object.defineProperty(response, 'finalUrlOverride', { value: finalUrl, configurable: true });
  } catch {
    // Response can be non-extensible in some runtimes; fall back to response.url.
  }
}

function finalResponseUrl(response: Response, fallbackUrl: string): string {
  return typeof (response as any).finalUrlOverride === 'string'
    ? (response as any).finalUrlOverride
    : response.url || fallbackUrl;
}
