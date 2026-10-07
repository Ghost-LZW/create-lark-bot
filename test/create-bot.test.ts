/**
 * createLarkBot / updateLarkBot orchestration (all IO mocked).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/create-app.js', () => ({ createFeishuOpenPlatformApp: vi.fn() }));
vi.mock('../src/register-app.js', async importOriginal => ({ ...(await importOriginal<object>()), registerLarkApp: vi.fn() }));
vi.mock('../src/open-platform.js', async importOriginal => ({ ...(await importOriginal<object>()), configureOpenPlatformApp: vi.fn() }));
vi.mock('../src/validate.js', () => ({ validateCredentials: vi.fn() }));
vi.mock('../src/owner.js', () => ({ resolveOwnerIdentity: vi.fn() }));
vi.mock('../src/existing-app.js', () => ({ selectExistingApp: vi.fn() }));
vi.mock('../src/update-app.js', () => ({ updateOpenPlatformAppIdentity: vi.fn() }));

import { createLarkBot, updateLarkBot } from '../src/create-bot.js';
import { createFeishuOpenPlatformApp } from '../src/create-app.js';
import { registerLarkApp } from '../src/register-app.js';
import { configureOpenPlatformApp } from '../src/open-platform.js';
import { validateCredentials } from '../src/validate.js';
import { resolveOwnerIdentity } from '../src/owner.js';
import { selectExistingApp } from '../src/existing-app.js';
import { updateOpenPlatformAppIdentity } from '../src/update-app.js';

const m = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const SECRET = 'app-secret-value-0123456789abcdef';
const consoleOk = {
  ok: true, appId: 'cli_c', appSecret: SECRET, brand: 'feishu', sessionFile: '/tmp/s.json', sessionSource: 'qr_login',
  sessionIdentity: { userId: 'u1', userName: 'Alice', email: 'a@x', tenantId: 't1', tenantName: 'T' },
  identity: { name: 'Bot', description: 'D', avatarUrl: 'https://cdn/x.png', avatarSource: 'default' }, warnings: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  m(validateCredentials).mockResolvedValue({ ok: true, tenantAccessToken: 't', tokenExpiresIn: 7200 });
  m(configureOpenPlatformApp).mockResolvedValue({ ok: true, scopeCount: 3 });
  m(resolveOwnerIdentity).mockResolvedValue({ status: 'verified', unionId: 'on_1', verified: { unionId: true, openId: false }, source: 'session_email' });
});

describe('createLarkBot', () => {
  it('default: console flow with identity, then configures on the SAME session (no second QR)', async () => {
    m(createFeishuOpenPlatformApp).mockResolvedValue(consoleOk);
    const result = await createLarkBot({ identity: { name: 'Bot', description: 'D' }, configure: { redirectUrls: ['http://x/cb'] } });
    expect(result).toMatchObject({ ok: true, appId: 'cli_c', source: 'console', identity: { name: 'Bot' }, owner: { unionId: 'on_1' } });
    expect(m(createFeishuOpenPlatformApp).mock.calls[0][0]).toMatchObject({ identity: { name: 'Bot', description: 'D' } });
    expect(m(registerLarkApp)).not.toHaveBeenCalled();
    expect(m(configureOpenPlatformApp).mock.calls[0][0]).toMatchObject({
      appId: 'cli_c', brand: 'feishu', appJustCreated: true, disableQrLogin: true, forceQrLogin: false, sessionFilePath: '/tmp/s.json', redirectUrls: ['http://x/cb'],
    });
    expect(m(resolveOwnerIdentity).mock.calls[0][0]).toMatchObject({ appId: 'cli_c', email: 'a@x', tenantAccessToken: 't' });
  });

  it('rejects an invalid avatar before any QR/creation', async () => {
    const result = await createLarkBot({ identity: { avatar: new Uint8Array([1, 2, 3]) } });
    expect(result).toMatchObject({ ok: false, stage: 'identity', error: 'invalid_identity' });
    expect(m(createFeishuOpenPlatformApp)).not.toHaveBeenCalled();
  });

  it('validates a URL avatar up front (console path); SDK mode passes identity as appPreset + manifest as addons', async () => {
    m(createFeishuOpenPlatformApp).mockResolvedValue({ ok: false, reason: 'missing_csrf', message: 'no csrf' });
    m(registerLarkApp).mockResolvedValue({ ok: true, appId: 'cli_s', appSecret: SECRET, brand: 'feishu', userOpenId: 'ou_scan' });
    const result = await createLarkBot({
      identity: { name: "{user}'s bot", description: 'D', avatar: 'https://img.example/a.png' },
      presets: ['messagingCore'],
      session: { fetchImpl: (async () => new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) as unknown as typeof fetch },
    });
    // invalid PNG download → identity error, before anything happens
    expect(result).toMatchObject({ ok: false, stage: 'identity' });

    const r2 = await createLarkBot({ mode: 'sdk', identity: { name: "{user}'s bot", description: 'D', avatar: 'https://img.example/a.png' }, presets: ['messagingCore'] });
    expect(r2).toMatchObject({ ok: true, source: 'sdk', appId: 'cli_s', userOpenId: 'ou_scan' });
    const sdkCall = m(registerLarkApp).mock.calls[0][0];
    expect(sdkCall).toMatchObject({
      appPreset: { name: "{user}'s bot", desc: 'D', avatar: 'https://img.example/a.png' },
      addons: { scopes: { tenant: expect.arrayContaining(['im:message:send_as_bot']) }, events: { items: { tenant: ['im.message.receive_v1'] } }, callbacks: { items: ['card.action.trigger'] } },
      createOnly: true,
    });
    expect(m(resolveOwnerIdentity).mock.calls[0][0]).toMatchObject({ openId: 'ou_scan' });
    // feishu tenant from SDK: configure runs with a (possibly new) session, not forced to cache-only
    expect(m(configureOpenPlatformApp).mock.calls[0][0]).not.toHaveProperty('disableQrLogin');
  });

  it('auto mode falls back to the SDK device flow when the console fails before creating anything', async () => {
    m(createFeishuOpenPlatformApp).mockResolvedValue({ ok: false, reason: 'api_error', message: 'boom' });
    m(registerLarkApp).mockResolvedValue({ ok: true, appId: 'cli_s', appSecret: SECRET, brand: 'feishu' });
    const result = await createLarkBot({ identity: { name: 'Bot' } });
    expect(result).toMatchObject({ ok: true, source: 'sdk' });
    if (result.ok) expect(result.warnings[0]).toMatch(/回退到 SDK/);
  });

  it('does not fall back to the SDK (which always shows a QR) under disableQrLogin or after an unscanned QR', async () => {
    m(createFeishuOpenPlatformApp).mockResolvedValue({ ok: false, reason: 'invalid_session', message: 'no cache' });
    expect(await createLarkBot({ session: { disableQrLogin: true } })).toMatchObject({ ok: false, stage: 'create', error: 'invalid_session' });
    m(createFeishuOpenPlatformApp).mockResolvedValue({ ok: false, reason: 'qr_expired', message: 'expired' });
    expect(await createLarkBot()).toMatchObject({ ok: false, error: 'qr_expired' });
    expect(m(registerLarkApp)).not.toHaveBeenCalled();
  });

  it('never falls back (no duplicate app) when the console already created the app', async () => {
    m(createFeishuOpenPlatformApp).mockResolvedValue({ ok: false, reason: 'api_error', message: 'commit failed', appId: 'cli_half' });
    const result = await createLarkBot();
    expect(result).toMatchObject({ ok: false, stage: 'create', appId: 'cli_half' });
    expect(m(registerLarkApp)).not.toHaveBeenCalled();
  });

  it('lark brand goes straight to the SDK and skips console configuration with a warning', async () => {
    m(registerLarkApp).mockResolvedValue({ ok: true, appId: 'cli_l', appSecret: SECRET, brand: 'lark' });
    const result = await createLarkBot({ brand: 'lark', identity: { avatar: './local.png' } });
    expect(m(createFeishuOpenPlatformApp)).not.toHaveBeenCalled();
    expect(m(configureOpenPlatformApp)).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.configuration).toBeUndefined();
      expect(result.warnings.join('\n')).toMatch(/URL/); // local avatar not passable to the SDK
      expect(result.warnings.join('\n')).toMatch(/Lark/);
    }
  });

  it('returns register failure without validate/configure', async () => {
    m(registerLarkApp).mockResolvedValue({ ok: false, error: 'expired', message: '二维码已过期' });
    const result = await createLarkBot({ mode: 'sdk' });
    expect(result).toMatchObject({ ok: false, stage: 'register', error: 'expired' });
    expect(m(validateCredentials)).not.toHaveBeenCalled();
    expect(m(configureOpenPlatformApp)).not.toHaveBeenCalled();
  });

  it('keeps ok=true with credentials when configuration fails; secrets redacted from warnings', async () => {
    m(createFeishuOpenPlatformApp).mockResolvedValue({ ...consoleOk, warnings: [`range failed ${SECRET}`] });
    m(configureOpenPlatformApp).mockResolvedValue({ ok: false, reason: 'session_expired', message: 'x' });
    const result = await createLarkBot();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.appSecret).toBe(SECRET);
      expect(result.configuration).toMatchObject({ ok: false, reason: 'session_expired' });
      expect(JSON.stringify(result.warnings)).not.toContain(SECRET);
    }
  });

  it('skips validate / configure / owner when disabled', async () => {
    m(createFeishuOpenPlatformApp).mockResolvedValue(consoleOk);
    const result = await createLarkBot({ validate: false, autoConfigure: false, resolveOwner: false });
    expect(result.ok && result.validation).toBeUndefined();
    expect(m(configureOpenPlatformApp)).not.toHaveBeenCalled();
    expect(m(resolveOwnerIdentity)).not.toHaveBeenCalled();
  });
});

describe('updateLarkBot', () => {
  const selected = {
    ok: true, appId: 'cli_e', appSecret: SECRET, brand: 'feishu', app: { clientId: 'cli_e', name: 'Existing' }, client: {},
    sessionIdentity: { userId: 'u1', userName: 'Alice', tenantId: 't', tenantName: 'T', email: 'a@x' }, sessionFile: '/tmp/s.json', sessionSource: 'cache', rescanned: false,
  };

  it('selects, updates identity, re-configures on the cached session', async () => {
    m(selectExistingApp).mockResolvedValue(selected);
    m(updateOpenPlatformAppIdentity).mockResolvedValue({ ok: true, changed: ['name'], versionId: 'v9' });
    const result = await updateLarkBot({ appId: 'cli_e', identity: { name: 'Renamed' }, presets: ['messagingCore'] });
    expect(result).toMatchObject({ ok: true, appId: 'cli_e', name: 'Renamed', identityUpdate: { ok: true } });
    expect(m(updateOpenPlatformAppIdentity).mock.calls[0][1]).toBe('cli_e');
    expect(m(configureOpenPlatformApp).mock.calls[0][0]).toMatchObject({ appId: 'cli_e', disableQrLogin: true, presets: ['messagingCore'] });
    expect(m(configureOpenPlatformApp).mock.calls[0][0]).not.toHaveProperty('appJustCreated');
  });

  it('surfaces session_expired from selection as a re-scan signal', async () => {
    m(selectExistingApp).mockResolvedValue({ ok: false, reason: 'session_expired', message: 'please log in again' });
    const result = await updateLarkBot({ appId: 'cli_e' });
    expect(result).toMatchObject({ ok: false, stage: 'select', error: 'session_expired' });
  });

  it('sdk mode uses the update-existing-app device flow', async () => {
    m(registerLarkApp).mockResolvedValue({ ok: true, appId: 'cli_e', appSecret: SECRET, brand: 'lark', userOpenId: 'ou_1' });
    const result = await updateLarkBot({ appId: 'cli_e', brand: 'lark', presets: ['messagingCore'] });
    expect(result).toMatchObject({ ok: true, source: 'sdk' });
    expect(m(registerLarkApp).mock.calls[0][0]).toMatchObject({ appId: 'cli_e', createOnly: false, addons: { events: { items: { tenant: ['im.message.receive_v1'] } } } });
  });
});
