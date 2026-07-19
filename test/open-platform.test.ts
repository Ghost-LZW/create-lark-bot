/**
 * 单测 Web session + 开放平台自动配置。
 */
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSafeSettingPayload,
  buildScopeUpdatePayload,
  configureOpenPlatformApp,
  extractOpenPlatformCsrfToken,
  extractOpenPlatformScopeEntries,
  mapManifestScopesToOpenPlatformIds,
  nextAppVersion,
} from '../src/open-platform.js';
import {
  buildQrLoginPayload,
  defaultSessionFilePath,
  getCookieHeader,
  mapQrPollingStatus,
  prepareWebSession,
  readStoredCookiesFromSessionFile,
  type StoredCookie,
  writeStoredCookiesToSessionFile,
} from '../src/web-session.js';
import { DEFAULT_EVENTS, DEFAULT_SCOPE_MANIFEST, VC_MEETING_BOT_EVENTS, VC_MEETING_TENANT_SCOPES } from '../src/presets.js';

function cookie(overrides: Partial<StoredCookie> = {}): StoredCookie {
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

describe('default presets', () => {
  it('default scope manifest includes the full VC meeting scopes', () => {
    const tenant = DEFAULT_SCOPE_MANIFEST.scopes?.tenant ?? [];
    for (const scope of [
      'vc:meeting.bot.join:write',
      'vc:meeting.bot.realtime:write',
      'vc:meeting.message:write',
      'vc:meeting.meetingevent:read',
    ]) {
      expect(tenant).toContain(scope);
      expect(VC_MEETING_TENANT_SCOPES).toContain(scope);
    }
  });

  it('default events include messaging baseline and VC meeting events', () => {
    expect(DEFAULT_EVENTS).toContain('im.message.receive_v1');
    expect(DEFAULT_EVENTS).toContain('card.action.trigger');
    for (const event of VC_MEETING_BOT_EVENTS) expect(DEFAULT_EVENTS).toContain(event);
  });
});

describe('web session cookie store', () => {
  it('writes private cookie jar and builds scoped cookie headers without expired cookies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'create-lark-bot-'));
    const file = join(dir, 'web-session.json');
    writeStoredCookiesToSessionFile(file, [
      cookie(),
      cookie({ name: 'expired', value: 'gone', expiresAt: Date.now() - 10 }),
      cookie({ name: 'askOnly', value: 'nope', domain: 'ask.feishu.cn', hostOnly: true }),
    ]);

    const cookies = readStoredCookiesFromSessionFile(file);
    expect(cookies?.map(c => c.name)).toEqual(['session', 'askOnly']);
    expect(getCookieHeader(cookies ?? [], 'https://open.feishu.cn/app/cli_x/auth')).toBe('session=secret-cookie-value');
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('resolves default session path under config dir', () => {
    expect(defaultSessionFilePath('/tmp/lark-bot-config')).toBe('/tmp/lark-bot-config/web-session.json');
  });
});

describe('payload helpers', () => {
  it('builds Feishu QR payload and maps polling status', () => {
    expect(buildQrLoginPayload('qr-token')).toBe(JSON.stringify({ qrlogin: { token: 'qr-token' } }));
    expect(mapQrPollingStatus(2)).toBe('已经扫码，等待手机确认');
    expect(mapQrPollingStatus(5)).toBe('二维码已过期');
    expect(mapQrPollingStatus(null)).toBe('等待飞书扫码');
  });

  it('extracts window.csrfToken from page HTML', () => {
    expect(extractOpenPlatformCsrfToken('<script>window.csrfToken = "csrf_123"</script>')).toBe('csrf_123');
  });

  it('maps tenant/user scope names to Open Platform IDs and builds payloads', () => {
    const entries = extractOpenPlatformScopeEntries({
      data: {
        appScopeList: [{ id: 101, name: 'im:message' }],
        userScopeList: [{ scopeId: '202', scopeName: 'auth:user_access_token:read' }],
      },
    });
    const mapped = mapManifestScopesToOpenPlatformIds(
      { scopes: { tenant: ['im:message'], user: ['auth:user_access_token:read'] } },
      entries,
    );

    expect(mapped).toEqual({
      tenantScopeIds: ['101'],
      userScopeIds: ['202'],
      missingTenantScopes: [],
      missingUserScopes: [],
    });
    expect(buildScopeUpdatePayload('cli_x', mapped)).toMatchObject({
      clientId: 'cli_x',
      appScopeIDs: ['101'],
      userScopeIDs: ['202'],
      operation: 'add',
      isDeveloperPanel: true,
    });
    expect(buildSafeSettingPayload('cli_x', ['http://127.0.0.1:9000/callback']).redirectURL).toEqual([
      'http://127.0.0.1:9000/callback',
    ]);
  });

  it('computes next app version from published versions', () => {
    expect(nextAppVersion({ data: { versions: [] } })).toBe('0.0.1');
    expect(nextAppVersion({ data: { versions: [{ versionStatus: 2, appVersion: '1.0.3' }] } })).toBe('1.0.4');
  });
});

describe('prepareWebSession', () => {
  it('gets a new session via built-in Feishu QR login and saves it privately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'create-lark-bot-'));
    const sessionFile = join(dir, 'web-session.json');
    const qrPayloads: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/accounts/qrlogin/init')) {
        return Response.json(
          { code: 0, data: { step_info: { token: 'qr-token' } } },
          { headers: { 'x-flow-key': 'flow-key' } },
        );
      }
      if (href.includes('/accounts/qrlogin/polling')) {
        return Response.json({
          code: 0,
          data: {
            next_step: 'enter_app',
            step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross-login' },
          },
        });
      }
      if (href === 'https://accounts.feishu.cn/cross-login') {
        return new Response('', {
          status: 302,
          headers: {
            location: 'https://ask.feishu.cn/',
            'set-cookie': 'session=secret-cookie-value; Domain=.feishu.cn; Path=/; Secure; HttpOnly',
          },
        });
      }
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await prepareWebSession({
      sessionFilePath: sessionFile,
      fetchImpl,
      pollIntervalMs: 0,
      maxWaitMs: 1000,
      onQrCode: ({ qrPayload }) => qrPayloads.push(qrPayload),
    });

    expect(result.ok && result.source).toBe('qr_login');
    expect(qrPayloads).toEqual([JSON.stringify({ qrlogin: { token: 'qr-token' } })]);
    expect(readStoredCookiesFromSessionFile(sessionFile)?.map(c => c.name)).toContain('session');
    if (process.platform !== 'win32') {
      expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
    }
  });

  it('uses fallback session files only after built-in QR login fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'create-lark-bot-'));
    const sessionFile = join(dir, 'web-session.json');
    const fallbackSessionFile = join(dir, 'other-tool-session.json');
    writeFileSync(fallbackSessionFile, JSON.stringify({ cookies: [cookie()] }));
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/accounts/qrlogin/init')) throw new Error('login down');
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await prepareWebSession({
      sessionFilePath: sessionFile,
      fallbackSessionFiles: [fallbackSessionFile],
      fetchImpl,
      onQrCode: () => {},
    });

    expect(result.ok && result.source).toBe('fallback_file');
    expect(readStoredCookiesFromSessionFile(sessionFile)?.map(c => c.name)).toContain('session');
  });
});

describe('configureOpenPlatformApp', () => {
  it('returns login failure so callers can fall back to manual steps without aborting', async () => {
    const fetchImpl = (async () => {
      throw new Error('login down');
    }) as typeof fetch;
    const result = await configureOpenPlatformApp({
      appId: 'cli_x',
      sessionFilePath: join(tmpdir(), `create-lark-bot-missing-${Date.now()}.json`),
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
      onQrCode: () => {},
      maxWaitMs: 1,
    });

    expect(result).toMatchObject({ ok: false, reason: 'login_failed' });
  });

  it('uses cached session cookies, page csrf, and calls the expected Open Platform endpoints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'create-lark-bot-'));
    const sessionFile = join(dir, 'web-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init: init ?? {} });
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) {
        return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      }
      if (href.includes('/scope/all/')) {
        return Response.json({
          code: 0,
          data: {
            appScopeList: [{ id: 'tenant-1', name: 'im:message' }],
            userScopeList: [{ id: 'user-1', name: 'auth:user_access_token:read' }],
          },
        });
      }
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await configureOpenPlatformApp({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: ['auth:user_access_token:read'] } },
      redirectUrls: ['http://127.0.0.1:9000/callback'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sessionSource).toBe('cache');
    expect(calls.filter(call => new URL(call.url).host === 'open.feishu.cn').map(call => new URL(call.url).pathname)).toEqual([
      '/app/cli_x/auth',
      '/developers/v1/scope/all/cli_x',
      '/developers/v1/scope/update/cli_x',
      '/developers/v1/event/update/cli_x',
      '/developers/v1/safe_setting/update/cli_x',
      '/developers/v1/contact_range/cli_x',
      '/developers/v1/app_version/list/cli_x',
      '/developers/v1/app_version/create/cli_x',
      '/developers/v1/publish/commit/cli_x/v1',
    ]);
    const updateCall = calls.find(call => call.url.includes('/scope/update/'));
    expect(new Headers(updateCall?.init.headers).get('x-csrf-token')).toBe('csrf_auto');
    expect(new Headers(updateCall?.init.headers).get('cookie')).toBe('session=secret-cookie-value');
    expect(JSON.parse(String(updateCall?.init.body))).toMatchObject({
      clientId: 'cli_x',
      appScopeIDs: ['tenant-1'],
      userScopeIDs: ['user-1'],
    });
    // 默认事件（含 VC）全量提交
    const eventCall = calls.find(call => call.url.includes('/event/update/'));
    const eventBody = JSON.parse(String(eventCall?.init.body));
    expect(eventBody.eventNames).toEqual(DEFAULT_EVENTS);
  });

  it('skips safe_setting when no redirect urls and skips version publish when disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'create-lark-bot-'));
    const sessionFile = join(dir, 'web-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) {
        return Response.json({ code: 0, data: { appScopeList: [{ id: 't1', name: 'im:message' }], userScopeList: [] } });
      }
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await configureOpenPlatformApp({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
      publishVersion: false,
    });

    expect(result.ok).toBe(true);
    expect(calls.some(u => u.includes('/safe_setting/update/'))).toBe(false);
    expect(calls.some(u => u.includes('/app_version/'))).toBe(false);
    expect(calls.some(u => u.includes('/publish/commit/'))).toBe(false);
  });

  it('uses the redirected Open Platform origin for API calls and referer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'create-lark-bot-'));
    const sessionFile = join(dir, 'web-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init: init ?? {} });
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href === 'https://open.feishu.cn/app/cli_x/auth') {
        return new Response('', {
          status: 302,
          headers: { location: 'https://open.larkoffice.com/app/cli_x/auth' },
        });
      }
      if (href === 'https://open.larkoffice.com/app/cli_x/auth') {
        return new Response('<script>window.csrfToken="csrf_larkoffice"</script>', {
          status: 200,
          headers: {
            'set-cookie': 'lark_oapi_csrf_token=csrf_larkoffice_cookie; Domain=.larkoffice.com; Path=/; Secure',
          },
        });
      }
      if (href.includes('/scope/all/')) {
        return Response.json({
          code: 0,
          data: { appScopeList: [{ id: 'tenant-1', name: 'im:message' }], userScopeList: [] },
        });
      }
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await configureOpenPlatformApp({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
    });

    expect(result.ok).toBe(true);
    const updateCall = calls.find(call => call.url === 'https://open.larkoffice.com/developers/v1/scope/update/cli_x');
    const updateHeaders = new Headers(updateCall?.init.headers);
    expect(updateHeaders.get('origin')).toBe('https://open.larkoffice.com');
    expect(updateHeaders.get('referer')).toBe('https://open.larkoffice.com/app/cli_x');
    expect(updateHeaders.get('x-csrf-token')).toBe('csrf_larkoffice');
    expect(updateHeaders.get('cookie')).toContain('lark_oapi_csrf_token=csrf_larkoffice_cookie');
  });

  it('treats a rejected scope batch as success (partial-permission tenants) and still publishes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'create-lark-bot-'));
    const sessionFile = join(dir, 'web-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) {
        return Response.json({ code: 0, data: { appScopeList: [{ id: 't1', name: 'im:message' }], userScopeList: [] } });
      }
      if (href.includes('/scope/update/')) return Response.json({ code: 1, msg: 'scope not grantable for tenant' });
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await configureOpenPlatformApp({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopeCount).toBe(0);
      expect(result.scopeWarning).toBeTruthy();
      expect(result.versionId).toBe('v1');
    }
    expect(calls.some(u => u.includes('/publish/commit/'))).toBe(true);
  });

  it('skips scope update when no manifest scope exists in this tenant catalog, still succeeding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'create-lark-bot-'));
    const sessionFile = join(dir, 'web-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) {
        return Response.json({ code: 0, data: { appScopeList: [], userScopeList: [] } });
      }
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await configureOpenPlatformApp({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message', 'contact:user.base:readonly'], user: ['auth:user_access_token:read'] } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopeCount).toBe(0);
      expect(result.skippedScopeCount).toBe(3);
    }
    expect(calls.some(u => u.includes('/scope/update/'))).toBe(false);
  });

  it('rejects lark brand with unsupported_brand', async () => {
    const result = await configureOpenPlatformApp({ appId: 'cli_x', brand: 'lark' });
    expect(result).toMatchObject({ ok: false, reason: 'unsupported_brand' });
  });
});
