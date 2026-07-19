/**
 * 飞书 Web QR 登录态管理（第二个二维码）。
 *
 * 直接实现飞书 Web 扫码登录：`accounts.feishu.cn/accounts/qrlogin/init` 初始化
 * → 终端渲染二维码 → 轮询 `/accounts/qrlogin/polling` → 跟随 cross-login URI
 * → 把 cookie jar 私有落盘（0600）。落盘后的 session 可复用——同一台机器
 * 再建 bot 时无需再次扫码。
 *
 * 实现源自 botmux（https://github.com/deepcoldy/botmux，MIT）的
 * src/setup/open-platform-automation.ts。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import qrcode from 'qrcode-terminal';

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
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  onQrCode?: (info: { qrText: string; qrPayload: string }) => void | Promise<void>;
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
  const cached = readStoredCookiesFromSessionFile(sessionFile);
  if (cached && cached.length > 0 && (await validateWebSession(cached, fetcher))) {
    return { ok: true, sessionFile, source: 'cache', cookies: cached, cookieCount: cached.length };
  }

  let loginError: unknown;
  try {
    const loggedIn = await loginWebSession(fetcher, options);
    writeStoredCookiesToSessionFile(sessionFile, loggedIn);
    return { ok: true, sessionFile, source: 'qr_login', cookies: loggedIn, cookieCount: loggedIn.length };
  } catch (err) {
    loginError = err;
  }

  for (const fallbackFile of options.fallbackSessionFiles ?? []) {
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
  for (;;) {
    if (Date.now() - start > maxWaitMs) {
      throw new WebSessionError('等待飞书扫码超时', 'timeout');
    }

    const poll = await pollQrLogin(session, fetcher, qrInit.flowKey);
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

  async fetchRaw(fetcher: typeof fetch, url: string, init: RequestInit = {}, maxHops = 10): Promise<Response> {
    let current = url;
    let referer: string | undefined;
    for (let hop = 0; hop <= maxHops; hop += 1) {
      const headers = new Headers(init.headers);
      const cookieHeader = getCookieHeader(this.cookies, current);
      if (cookieHeader) headers.set('cookie', cookieHeader);
      headers.set('user-agent', headers.get('user-agent') ?? DEFAULT_BROWSER_USER_AGENT);
      if (referer && !headers.has('referer')) headers.set('referer', referer);

      const response = await fetcher(current, { ...init, headers, redirect: 'manual' });
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
  process.stderr.write('\n请用飞书 App 扫码登录（用于开放平台自动配置）：\n\n');
  process.stderr.write(`${info.qrText}\n`);
}

async function renderTerminalQr(payload: string): Promise<string> {
  return await new Promise(resolve => qrcode.generate(payload, { small: true }, qr => resolve(qr)));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

export function safeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/[A-Za-z0-9_=-]{24,}/g, '***');
}

export function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
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
