/**
 * Console app creation with a custom identity (fake console, no network).
 */
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFeishuOpenPlatformApp } from '../src/create-app.js';
import { defaultAppIcon, validateAvatarPng } from '../src/identity.js';
import { cachedSessionFile, fakeConsole, json, SESSION_USER } from './helpers/fake-console.js';

const SECRET = 'app-secret-value-0123456789abcdef';

async function formFields(body: unknown): Promise<Record<string, unknown>> {
  const form = body as FormData;
  const out: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) out[k] = typeof v === 'string' ? v : { size: (v as Blob).size, type: (v as Blob).type, bytes: Buffer.from(await (v as Blob).arrayBuffer()) };
  return out;
}

describe('createFeishuOpenPlatformApp', () => {
  it('creates via the one-click template with the chosen name/description/icon, enables, publishes, reads the secret', async () => {
    const fc = fakeConsole({ handlers: { '/developers/v1/manifest/upsert_by_template': () => json({ code: 0, data: { ClientID: 'cli_new' } }) } });
    const result = await createFeishuOpenPlatformApp({
      sessionFilePath: cachedSessionFile(),
      fetchImpl: fc.fetchImpl,
      identity: { name: 'Ops Helper', description: "{user}'s helper" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({ appId: 'cli_new', appSecret: SECRET, brand: 'feishu', sessionSource: 'cache' });
    expect(result.identity).toMatchObject({ name: 'Ops Helper', description: "Alice's helper", avatarSource: 'default' });
    expect(result.sessionIdentity).toMatchObject({ userId: SESSION_USER.id, userName: 'Alice', tenantName: 'Example Corp', email: 'alice@example.com' });

    expect(fc.paths()).toEqual([
      '/developers/v1/app/upload/image',
      '/developers/v1/manifest/upsert_by_template',
      '/developers/v1/robot/switch/cli_new',
      '/developers/v1/event/switch/cli_new',
      '/developers/v1/privilege/all/cli_new',
      '/developers/v1/app_version/create/cli_new',
      '/developers/v1/publish/commit/cli_new/v_1',
      '/developers/v1/secret/cli_new',
    ]);
    const upload = await formFields(fc.find('/app/upload/image')!.body);
    expect(upload.uploadType).toBe('4');
    expect(upload.isIsv).toBe('false');
    expect(upload.scale).toBe('{"width":512,"height":512}');
    expect((upload.file as any).type).toBe('image/png');
    expect(validateAvatarPng((upload.file as any).bytes).ok).toBe(true);

    expect(fc.find('/manifest/upsert_by_template')!.body).toMatchObject({
      appManifestTemplateID: 'developer_console',
      createAppUserCustomField: {
        i18n: { zh_cn: { name: 'Ops Helper', description: "Alice's helper" } },
        avatar: 'https://cdn.example/icon.png',
        primaryLang: 'zh_cn',
      },
    });
    // first version visible to the creator so the app auto-enables
    expect(fc.find('/app_version/create/')!.body).toMatchObject({ appVersion: '1.0.0', visibleSuggest: { members: [SESSION_USER.id] } });
    // the secret is read, never reset
    expect(fc.paths().some(p => p.includes('/secret/reset'))).toBe(false);
  });

  it('uploads a custom PNG avatar from a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'create-lark-bot-'));
    const file = join(dir, 'me.png');
    const png = defaultAppIcon();
    png[png.length - 20] ^= 0; // same bytes; just a distinct file
    writeFileSync(file, png);
    const fc = fakeConsole({ handlers: { '/developers/v1/manifest/upsert_by_template': () => json({ code: 0, data: { ClientID: 'cli_new' } }) } });
    const result = await createFeishuOpenPlatformApp({ sessionFilePath: cachedSessionFile(), fetchImpl: fc.fetchImpl, identity: { name: 'x', avatar: file } });
    expect(result.ok && result.identity.avatarSource).toBe('file');
    const upload = await formFields(fc.find('/app/upload/image')!.body);
    expect(Buffer.compare((upload.file as any).bytes, png)).toBe(0);
  });

  it('rejects an invalid avatar before anything is created', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'create-lark-bot-'));
    const file = join(dir, 'me.jpg');
    writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    const fc = fakeConsole();
    const result = await createFeishuOpenPlatformApp({ sessionFilePath: cachedSessionFile(), fetchImpl: fc.fetchImpl, identity: { avatar: file } });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_identity' });
    expect(fc.find('/upsert_by_template')).toBeUndefined();
    expect(fc.find('/app/create')).toBeUndefined();
  });

  it('defaults to a neutral name with a numeric suffix when taken', async () => {
    const fc = fakeConsole({
      appList: [{ clientId: 'cli_a', name: 'lark-bot' }, { clientId: 'cli_b', name: 'lark-bot-2' }],
      handlers: { '/developers/v1/manifest/upsert_by_template': () => json({ code: 0, data: { ClientID: 'cli_new' } }) },
    });
    const result = await createFeishuOpenPlatformApp({ sessionFilePath: cachedSessionFile(), fetchImpl: fc.fetchImpl });
    expect(result.ok && result.identity.name).toBe('lark-bot-3');
    expect(result.ok && result.identity.description).toBe('A Feishu/Lark bot.');
    const body = JSON.stringify(fc.posts().map(c => (c.body instanceof FormData ? null : c.body)));
    expect(body.toLowerCase()).not.toContain('botmux');
  });

  it('falls back to app/create only on a definite template rejection', async () => {
    const fc = fakeConsole({
      handlers: {
        '/developers/v1/manifest/upsert_by_template': () => json({ code: 1001, msg: 'template disabled' }),
        '/developers/v1/app/create': () => json({ code: 0, data: { ClientID: 'cli_plain' } }),
      },
    });
    const result = await createFeishuOpenPlatformApp({ sessionFilePath: cachedSessionFile(), fetchImpl: fc.fetchImpl, identity: { name: 'Plain', description: 'd' } });
    expect(result.ok && result.appId).toBe('cli_plain');
    expect(fc.find('/app/create')!.body).toMatchObject({ appSceneType: 0, name: 'Plain', desc: 'd', avatar: 'https://cdn.example/icon.png' });
  });

  it('does NOT fall back when the template outcome is unknown (5xx) — no duplicate apps', async () => {
    const fc = fakeConsole({ handlers: { '/developers/v1/manifest/upsert_by_template': () => json({ msg: 'boom' }, { status: 502 }) } });
    const result = await createFeishuOpenPlatformApp({ sessionFilePath: cachedSessionFile(), fetchImpl: fc.fetchImpl, identity: { name: 'x' } });
    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    expect(fc.find('/app/create')).toBeUndefined();
  });

  it('returns the appId when the app exists but a later step fails, without leaking the secret', async () => {
    const fc = fakeConsole({
      handlers: {
        '/developers/v1/manifest/upsert_by_template': () => json({ code: 0, data: { ClientID: 'cli_half' } }),
        '/developers/v1/publish/commit/cli_half/v_1': () => json({ code: 5, msg: `failed for ${SECRET}` }),
      },
    });
    const result = await createFeishuOpenPlatformApp({ sessionFilePath: cachedSessionFile(), fetchImpl: fc.fetchImpl, identity: { name: 'x' } });
    expect(result).toMatchObject({ ok: false, appId: 'cli_half' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('refuses when the session belongs to another account (expectedIdentity)', async () => {
    const fc = fakeConsole();
    const result = await createFeishuOpenPlatformApp({
      sessionFilePath: cachedSessionFile(),
      fetchImpl: fc.fetchImpl,
      expectedIdentity: { userId: 'someone-else', tenantId: 't_1' },
    });
    expect(result).toMatchObject({ ok: false, reason: 'session_changed' });
    expect(fc.find('/upload/image')).toBeUndefined();
  });

  it('refuses when the console does not expose who is signed in', async () => {
    const fc = fakeConsole({ includeUser: false });
    const result = await createFeishuOpenPlatformApp({ sessionFilePath: cachedSessionFile(), fetchImpl: fc.fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: 'identity_unavailable' });
  });
});
