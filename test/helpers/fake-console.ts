/**
 * In-memory fake of the Feishu Web login probe + Open Platform console, for fetch injection.
 * No network. Records every console call (path + parsed body).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeStoredCookiesToSessionFile, type StoredCookie } from '../../src/web-session.js';

export interface ConsoleCall {
  method: string;
  url: string;
  path: string;
  body: unknown;
  headers: Headers;
}

export type Handler = (call: ConsoleCall) => Response | Promise<Response> | undefined;

export const SESSION_USER = {
  id: 'u_console_1',
  name: 'Alice',
  email: 'alice@example.com',
  tenantId: 't_1',
  tenantDisplayName: { value: 'Example Corp' },
};

export function sessionCookie(overrides: Partial<StoredCookie> = {}): StoredCookie {
  return {
    name: 'session',
    value: 'secret-cookie-value',
    domain: '.feishu.cn',
    path: '/',
    secure: true,
    httpOnly: true,
    hostOnly: false,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

/** A temp session file pre-seeded with a valid cookie (→ zero-scan cache path). */
export function cachedSessionFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'create-lark-bot-'));
  const file = join(dir, 'web-session.json');
  writeStoredCookiesToSessionFile(file, [sessionCookie()]);
  return file;
}

export function emptySessionFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'create-lark-bot-')), 'web-session.json');
}

export const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);

export interface FakeConsoleOptions {
  /** Per-path overrides; return undefined to fall through to the defaults. */
  handlers?: Record<string, Handler>;
  /** Matched by `path.includes(key)` after exact handlers. */
  prefixHandlers?: Record<string, Handler>;
  /** Event/callback state the fake keeps (starts empty, `add` operations append). */
  initialEvents?: { app?: string[]; user?: string[]; eventMode?: number };
  initialCallbacks?: { callbacks?: string[]; callbackMode?: number };
  scopeCatalog?: Array<{ id: string; name: string; bucket: 'app' | 'user' }>;
  versions?: Array<{ versionId: string; appVersion: string; versionStatus: number }>;
  visibleOnline?: unknown;
  safeSetting?: unknown;
  appList?: Array<{ clientId: string; name: string }>;
  secret?: string;
  includeUser?: boolean;
}

export function fakeConsole(opts: FakeConsoleOptions = {}) {
  const calls: ConsoleCall[] = [];
  const state = {
    events: { app: [...(opts.initialEvents?.app ?? [])], user: [...(opts.initialEvents?.user ?? [])], eventMode: opts.initialEvents?.eventMode ?? 4 },
    callbacks: { callbacks: [...(opts.initialCallbacks?.callbacks ?? [])], callbackMode: opts.initialCallbacks?.callbackMode ?? 4 },
    versions: [...(opts.versions ?? [])],
    redirect: opts.safeSetting,
  };
  const userJson = JSON.stringify(SESSION_USER);
  const page = `<script>window.csrfToken="csrf_fake";${opts.includeUser === false ? '' : `window.user = ${userJson};`}</script>`;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const parsed = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = init?.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { /* keep string */ }
    }
    const call: ConsoleCall = { method, url, path: parsed.pathname, body, headers: new Headers(init?.headers) };
    if (parsed.host === 'ask.feishu.cn') return new Response('ask home', { status: 200 });
    calls.push(call);
    const exact = opts.handlers?.[call.path];
    if (exact) {
      const r = await exact(call);
      if (r) return r;
    }
    for (const [key, h] of Object.entries(opts.prefixHandlers ?? {})) {
      if (call.path.includes(key)) {
        const r = await h(call);
        if (r) return r;
      }
    }
    if (method === 'GET' && (call.path === '/app' || call.path.startsWith('/app/'))) return new Response(page, { status: 200 });
    const p = call.path;
    const b = (call.body ?? {}) as Record<string, any>;
    if (p === '/developers/v1/app/upload/image') return json({ code: 0, data: { url: 'https://cdn.example/icon.png' } });
    if (p === '/developers/v1/app/list') return json({ code: 0, data: { apps: opts.appList ?? [], totalCount: (opts.appList ?? []).length } });
    if (p.startsWith('/developers/v1/secret/')) return json({ code: 0, data: { secret: opts.secret ?? 'app-secret-value-0123456789abcdef' } });
    if (p.startsWith('/developers/v1/scope/all/')) {
      const cat = opts.scopeCatalog ?? [];
      return json({
        code: 0,
        data: {
          appScopeList: cat.filter(c => c.bucket === 'app').map(c => ({ id: c.id, name: c.name })),
          userScopeList: cat.filter(c => c.bucket === 'user').map(c => ({ id: c.id, name: c.name })),
        },
      });
    }
    if (p.startsWith('/developers/v1/privilege/all/')) return json({ code: 0, data: { privileges: [], scopeBiz: [] } });
    if (p.startsWith('/developers/v1/event/update/')) {
      state.events.app.push(...(b.appEvents ?? []));
      state.events.user.push(...(b.userEvents ?? []));
      return json({ code: 0 });
    }
    if (p.startsWith('/developers/v1/event/switch/')) {
      state.events.eventMode = b.eventMode;
      return json({ code: 0 });
    }
    if (p.startsWith('/developers/v1/event/')) {
      return json({ code: 0, data: { eventMode: state.events.eventMode, appEvents: state.events.app, userEvents: state.events.user } });
    }
    if (p.startsWith('/developers/v1/callback/update/')) {
      state.callbacks.callbacks.push(...(b.callbacks ?? []));
      return json({ code: 0 });
    }
    if (p.startsWith('/developers/v1/callback/switch/')) {
      state.callbacks.callbackMode = b.callbackMode;
      return json({ code: 0 });
    }
    if (p.startsWith('/developers/v1/callback/')) return json({ code: 0, data: { ...state.callbacks } });
    if (p.startsWith('/developers/v1/safe_setting/update/')) {
      state.redirect = { allowRefreshToken: true, ipWhiteList: [], safeServerDomain: [], redirectURL: b.redirectURL };
      return json({ code: 0 });
    }
    if (p.startsWith('/developers/v1/safe_setting/')) {
      return json({ code: 0, data: state.redirect ?? { allowRefreshToken: true, ipWhiteList: [], safeServerDomain: [] } });
    }
    if (p.startsWith('/developers/v1/visible/online/')) {
      return json(opts.visibleOnline ?? {
        code: 0,
        data: {
          whiteList: { departments: [], groups: [], members: [{ id: 'ou_member' }], isAll: 0 },
          blackList: { departments: [], groups: [], members: [], isAll: 0 },
        },
      });
    }
    if (p.startsWith('/developers/v1/app_version/list/')) return json({ code: 0, data: { versions: state.versions } });
    if (p.startsWith('/developers/v1/app_version/create/')) {
      const versionId = `v_${state.versions.length + 1}`;
      state.versions.unshift({ versionId, appVersion: b.appVersion, versionStatus: 0 });
      return json({ code: 0, data: { versionId } });
    }
    if (p.startsWith('/developers/v1/publish/commit/')) {
      const id = p.split('/').pop();
      for (const v of state.versions) if (v.versionId === id) v.versionStatus = 2;
      return json({ code: 0, data: { isOk: true } });
    }
    if (p.startsWith('/developers/v1/approval_nodes/get/')) return json({ code: 0, data: {} });
    return json({ code: 0, data: {} });
  }) as typeof fetch;

  const posts = () => calls.filter(c => c.method === 'POST');
  const paths = () => posts().map(c => c.path);
  const find = (frag: string) => posts().find(c => c.path.includes(frag));
  const findAll = (frag: string) => posts().filter(c => c.path.includes(frag));
  return { fetchImpl, calls, posts, paths, find, findAll, state };
}
