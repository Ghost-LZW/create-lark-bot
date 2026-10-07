import { describe, expect, it } from 'vitest';
import { createOpenPlatformApiClient } from '../src/console-client.js';
import { selectExistingApp } from '../src/existing-app.js';
import { updateOpenPlatformAppIdentity } from '../src/update-app.js';
import { cachedSessionFile, fakeConsole, json, sessionCookie } from './helpers/fake-console.js';

const LOGOUT = () => json({ code: 99991641, msg: 'error', error: { Code: 4101, LogoutReason: 40, message: 'please log in again' } }, { status: 400 });

describe('selectExistingApp', () => {
  it('lists apps, lets the caller pick, reads the secret read-only', async () => {
    const fc = fakeConsole({ appList: [{ clientId: 'cli_a', name: 'A' }, { clientId: 'cli_b', name: 'B' }] });
    const seen: string[] = [];
    const result = await selectExistingApp({
      sessionFilePath: cachedSessionFile(),
      fetchImpl: fc.fetchImpl,
      pick: apps => { seen.push(...apps.map(a => a.name)); return 'cli_b'; },
    });
    expect(seen).toEqual(['A', 'B']);
    expect(result).toMatchObject({ ok: true, appId: 'cli_b', appSecret: 'app-secret-value-0123456789abcdef', rescanned: false });
    expect(fc.paths()).toContain('/developers/v1/secret/cli_b');
    expect(fc.paths().some(p => p.includes('reset'))).toBe(false);
  });

  it('returns not_found / cancelled / no_apps distinctly', async () => {
    const fc = fakeConsole({ appList: [{ clientId: 'cli_a', name: 'A' }] });
    expect(await selectExistingApp({ sessionFilePath: cachedSessionFile(), fetchImpl: fc.fetchImpl, appId: 'cli_zzz' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await selectExistingApp({ sessionFilePath: cachedSessionFile(), fetchImpl: fc.fetchImpl, pick: () => null })).toMatchObject({ ok: false, reason: 'cancelled' });
    const empty = fakeConsole({ appList: [] });
    expect(await selectExistingApp({ sessionFilePath: cachedSessionFile(), fetchImpl: empty.fetchImpl, pick: () => 'x' })).toMatchObject({ ok: false, reason: 'no_apps' });
  });

  it('signals session_expired (re-scan needed) when the console logged the session out', async () => {
    const fc = fakeConsole({ handlers: { '/developers/v1/app/list': LOGOUT } });
    const result = await selectExistingApp({ sessionFilePath: cachedSessionFile(), fetchImpl: fc.fetchImpl, appId: 'cli_a' });
    expect(result).toMatchObject({ ok: false, reason: 'session_expired' });
  });

  it('re-scans once with forceQrLogin when allowed, then succeeds', async () => {
    let loggedOut = true;
    let qrShown = 0;
    const fc = fakeConsole({
      appList: [{ clientId: 'cli_a', name: 'A' }],
      handlers: {
        '/developers/v1/app/list': () => (loggedOut ? LOGOUT() : undefined),
        '/accounts/qrlogin/init': () => json({ code: 0, data: { step_info: { token: 'qr' } } }, { headers: { 'x-flow-key': 'fk' } }),
        '/accounts/qrlogin/polling': () => {
          loggedOut = false;
          return json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross' } } });
        },
        '/cross': () => new Response('', { status: 302, headers: { location: 'https://ask.feishu.cn/', 'set-cookie': `${sessionCookie().name}=fresh; Domain=.feishu.cn; Path=/; Secure` } }),
      },
    });
    const asked: string[] = [];
    const result = await selectExistingApp({
      sessionFilePath: cachedSessionFile(),
      fetchImpl: fc.fetchImpl,
      appId: 'cli_a',
      pollIntervalMs: 0,
      onQrCode: () => { qrShown++; },
      allowRescan: detail => { asked.push(detail); return true; },
    });
    expect(asked).toHaveLength(1);
    expect(qrShown).toBe(1);
    expect(result).toMatchObject({ ok: true, appId: 'cli_a', rescanned: true });
  });

  it('does not loop: a second expiry after a fresh scan is reported', async () => {
    const fc = fakeConsole({ handlers: { '/developers/v1/app/list': LOGOUT } });
    const result = await selectExistingApp({ sessionFilePath: cachedSessionFile(), fetchImpl: fc.fetchImpl, appId: 'cli_a', forceQrLogin: true, onQrCode: () => {}, maxWaitMs: 1 });
    expect(result.ok).toBe(false);
  });
});

describe('updateOpenPlatformAppIdentity', () => {
  const baseInfo = {
    code: 0,
    data: {
      name: 'Old', desc: 'old desc', primaryLang: 'zh_cn', langs: ['zh_cn', 'en_us'], avatar: 'https://cdn.example/old.png',
      i18n: { zh_cn: { name: 'Old', description: 'old desc', help: 'h' }, en_us: { name: 'Old EN', description: 'old en' } },
    },
  };

  async function client(fc: ReturnType<typeof fakeConsole>) {
    const r = await createOpenPlatformApiClient([sessionCookie()], { fetchImpl: fc.fetchImpl });
    if (!r.ok) throw new Error('no client');
    return r.client;
  }

  it('writes base_info in full (all languages kept), uploads the avatar, publishes mirroring visibility', async () => {
    const fc = fakeConsole({ handlers: { '/developers/v1/app/cli_x': () => json(baseInfo) }, versions: [{ versionId: 'v0', appVersion: '1.0.0', versionStatus: 2 }] });
    const result = await updateOpenPlatformAppIdentity(await client(fc), 'cli_x', { name: 'New {user}', description: 'new desc' }, { userName: 'Alice' });
    expect(result).toMatchObject({ ok: true, changed: ['name', 'description'], versionId: 'v_2' });
    expect(fc.find('/base_info/')!.body).toEqual({
      clientId: 'cli_x', name: 'New Alice', desc: 'new desc', languages: ['zh_cn', 'en_us'], avatar: 'https://cdn.example/old.png',
      i18n: { zh_cn: { name: 'New Alice', description: 'new desc', help: 'h' }, en_us: { name: 'New Alice', description: 'new desc' } },
    });
    expect(fc.find('/app_version/create/')!.body).toMatchObject({ appVersion: '1.0.1', visibleSuggest: { members: ['ou_member'] } });
  });

  it('fails closed (no write) when base info is unreadable', async () => {
    const fc = fakeConsole({ handlers: { '/developers/v1/app/cli_x': () => json({ code: 0, data: { name: 'Old', langs: ['zh_cn'] } }) } });
    const result = await updateOpenPlatformAppIdentity(await client(fc), 'cli_x', { name: 'New' });
    expect(result).toMatchObject({ ok: false, reason: 'unreadable_base_info' });
    expect(fc.find('/base_info/')).toBeUndefined();
  });

  it('rejects an invalid avatar before reading anything', async () => {
    const fc = fakeConsole();
    const result = await updateOpenPlatformAppIdentity(await client(fc), 'cli_x', { avatar: new Uint8Array([1, 2, 3]) });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_identity' });
    expect(fc.find('/developers/v1/app/cli_x')).toBeUndefined();
  });
});
