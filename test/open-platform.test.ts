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
  extractOpenPlatformScopeEntries,
  mapManifestScopesToOpenPlatformIds,
  nextAppVersion,
} from '../src/console-ops.js';
import { extractOpenPlatformCsrfToken } from '../src/console-client.js';
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

  it('default events include messaging baseline and VC meeting events; card.action.trigger is a callback', () => {
    expect(DEFAULT_EVENTS).toContain('im.message.receive_v1');
    expect(DEFAULT_EVENTS).not.toContain('card.action.trigger');
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

  it('computes next app version from ALL versions (drafts included)', () => {
    expect(nextAppVersion({ data: { versions: [] } })).toBe('0.0.1');
    expect(nextAppVersion({ data: { versions: [{ versionStatus: 2, appVersion: '1.0.3' }] } })).toBe('1.0.4');
    expect(nextAppVersion({ data: { versions: [{ versionStatus: 2, appVersion: '1.0.3' }, { versionStatus: 0, appVersion: '1.0.9' }] } })).toBe('1.0.10');
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

  it('honours disableQrLogin (never shows a QR) and forceQrLogin (ignores the cache)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'create-lark-bot-'));
    const sessionFile = join(dir, 'web-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    let qrShown = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('accounts/login', { status: 200 }); // looks logged out
      throw new Error('login down');
    }) as typeof fetch;
    const noQr = await prepareWebSession({ sessionFilePath: sessionFile, fetchImpl, disableQrLogin: true, onQrCode: () => { qrShown++; } });
    expect(noQr).toMatchObject({ ok: false, reason: 'invalid_session' });
    expect(qrShown).toBe(0);

    const okFetch = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      throw new Error('login down');
    }) as typeof fetch;
    const forced = await prepareWebSession({ sessionFilePath: sessionFile, fetchImpl: okFetch, forceQrLogin: true, onQrCode: () => { qrShown++; } });
    expect(forced.ok).toBe(false); // the cache was valid but ignored, and login failed
  });
});
