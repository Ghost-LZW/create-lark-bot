import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCredentialsFile, updateEnvFile, writeCredentialsFile } from '../src/output.js';
import { resolveOwnerIdentity } from '../src/owner.js';
import { verifyLarkBot } from '../src/verify.js';

const SECRET = 'app-secret-value-0123456789abcdef';

function openApi(routes: Record<string, (init: RequestInit | undefined, url: URL) => unknown>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    const route = routes[url.pathname] ?? Object.entries(routes).find(([k]) => url.pathname.startsWith(k))?.[1];
    if (!route) return Response.json({ code: 404, msg: 'no route' }, { status: 404 });
    const body = route(init, url);
    if (body instanceof Error) throw body;
    return Response.json(body);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const token = { '/open-apis/auth/v3/tenant_access_token/internal': () => ({ code: 0, tenant_access_token: 't-123', expire: 7200 }) };

describe('resolveOwnerIdentity', () => {
  it('verifies the scanner open_id through the new app and returns union_id', async () => {
    const api = openApi({ ...token, '/open-apis/contact/v3/users/': () => ({ code: 0, data: { user: { union_id: 'on_1', open_id: 'ou_1', name: 'Alice' } } }) });
    const owner = await resolveOwnerIdentity({ appId: 'cli_x', appSecret: SECRET, openId: 'ou_1', fetchImpl: api.fetchImpl });
    expect(owner).toEqual({ openId: 'ou_1', unionId: 'on_1', name: 'Alice', verified: { unionId: true, openId: true }, source: 'scan_open_id', status: 'verified' });
    const lookup = api.calls.find(c => c.url.includes('/contact/v3/users/'))!;
    expect(lookup.url).toContain('user_id_type=open_id');
    expect(new Headers(lookup.init?.headers).get('authorization')).toBe('Bearer t-123');
  });

  it('never marks an open_id as verified when the app cannot resolve it', async () => {
    const api = openApi({ ...token, '/open-apis/contact/v3/users/': () => ({ code: 99992361, msg: 'open_id cross app' }) });
    const owner = await resolveOwnerIdentity({ appId: 'cli_x', appSecret: SECRET, openId: 'ou_other', fetchImpl: api.fetchImpl });
    expect(owner).toMatchObject({ status: 'unverified', openId: 'ou_other', verified: { unionId: false, openId: false } });
    expect(owner.unionId).toBeUndefined();
    expect(owner.reason).toMatch(/99992361/);
  });

  it('resolves the console session email to union_id + open_id', async () => {
    const api = openApi({
      ...token,
      '/open-apis/contact/v3/users/batch_get_id': (_init, url) => ({
        code: 0, data: { user_list: [{ email: 'a@x', user_id: url.searchParams.get('user_id_type') === 'union_id' ? 'on_2' : 'ou_2' }] },
      }),
    });
    const owner = await resolveOwnerIdentity({ appId: 'cli_x', appSecret: SECRET, email: 'a@x', fetchImpl: api.fetchImpl });
    expect(owner).toMatchObject({ status: 'verified', unionId: 'on_2', openId: 'ou_2', source: 'session_email', verified: { unionId: true, openId: true } });
  });

  it('reports unresolved without any input', async () => {
    const owner = await resolveOwnerIdentity({ appId: 'cli_x', appSecret: SECRET, fetchImpl: openApi({}).fetchImpl });
    expect(owner).toMatchObject({ status: 'unresolved', verified: { unionId: false, openId: false } });
  });
});

describe('verifyLarkBot', () => {
  it('reports credentials/bot/scopes ok, events unknown, ws skipped, plus links and import JSON', async () => {
    const api = openApi({
      ...token,
      '/open-apis/bot/v3/info': () => ({ code: 0, bot: { open_id: 'ou_bot', app_name: 'Bot' } }),
      '/open-apis/application/v6/applications/': () => ({ code: 0, data: { app: { scopes: ['im:message:send_as_bot', 'im:message', 'im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly'].map(scope => ({ scope })) } } }),
    });
    const report = await verifyLarkBot({ appId: 'cli_x', appSecret: SECRET, presets: ['messagingCore'], fetchImpl: api.fetchImpl });
    expect(report.ok).toBe(true);
    expect(report.checks.map(c => [c.id, c.status])).toEqual([['credentials', 'ok'], ['bot', 'ok'], ['scopes', 'ok'], ['events', 'unknown'], ['ws', 'skipped']]);
    expect(report.links.scopes).toBe('https://open.feishu.cn/app/cli_x/auth');
    expect(report.scopesJson.scopes?.tenant).toContain('im:message:send_as_bot');
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('fails on a missing required scope with a deep link; optional ones only listed', async () => {
    const api = openApi({
      ...token,
      '/open-apis/bot/v3/info': () => ({ code: 0, bot: { open_id: 'ou_bot' } }),
      '/open-apis/application/v6/applications/': () => ({ code: 0, data: { app: { scopes: [{ scope: 'im:message' }] } } }),
    });
    const report = await verifyLarkBot({ appId: 'cli_x', appSecret: SECRET, presets: ['messagingCore', 'contact'], fetchImpl: api.fetchImpl });
    expect(report.ok).toBe(false);
    const req = report.missingScopes.find(s => s.name === 'im:message:send_as_bot')!;
    expect(req.required).toBe(true);
    expect(req.link).toContain('q=im%3Amessage%3Asend_as_bot');
    expect(report.missingScopes.find(s => s.name === 'contact:user.base:readonly')?.required).toBe(false);
  });

  it('is honest when the scope readback is not permitted (unknown, not fail)', async () => {
    const api = openApi({
      ...token,
      '/open-apis/bot/v3/info': () => ({ code: 0, bot: { open_id: 'ou_bot' } }),
      '/open-apis/application/v6/applications/': () => ({ code: 99991672, msg: 'no permission' }),
    });
    const report = await verifyLarkBot({ appId: 'cli_x', appSecret: SECRET, fetchImpl: api.fetchImpl });
    expect(report.checks.find(c => c.id === 'scopes')).toMatchObject({ status: 'unknown' });
    expect(report.ok).toBe(true);
  });

  it('fails on bad credentials and runs the live WS probe via the injected client', async () => {
    const bad = openApi({ '/open-apis/auth/v3/tenant_access_token/internal': () => ({ code: 10003, msg: 'invalid app_secret' }) });
    let closed = false;
    const report = await verifyLarkBot({
      appId: 'cli_x', appSecret: SECRET, fetchImpl: bad.fetchImpl, live: true, brand: 'lark',
      createWsClient: () => ({ start: async () => {}, getConnectionStatus: () => ({ state: 'connected' }), close: () => { closed = true; } }),
    });
    expect(report.checks.find(c => c.id === 'credentials')).toMatchObject({ status: 'fail' });
    expect(report.checks.find(c => c.id === 'ws')).toMatchObject({ status: 'ok' });
    expect(closed).toBe(true);
    expect(report.links.home).toBe('https://open.larksuite.com/app/cli_x');
    expect(bad.calls[0].url).toContain('open.larksuite.com');
  });
});

describe('output files', () => {
  it('writes credentials 0600 in a 0700 directory', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'create-lark-bot-')), 'nested');
    const file = join(dir, 'app.json');
    writeCredentialsFile(file, { appId: 'cli_x', appSecret: SECRET, brand: 'feishu' });
    expect(readCredentialsFile(file)).toMatchObject({ appId: 'cli_x', appSecret: SECRET, brand: 'feishu' });
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it('updates .env in place, preserving other lines, merging list keys, 0600', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'create-lark-bot-')), '.env');
    writeFileSync(file, '# config\nexport LARK_APP_ID=old\nOTHER=1\nOWNERS=on_a\n', { mode: 0o644 });
    const r = updateEnvFile(file, { LARK_APP_ID: 'cli_x', LARK_APP_SECRET: SECRET, LARK_DOMAIN: 'feishu', OWNERS: 'on_b' }, { mergeListKeys: ['OWNERS'] });
    expect(r).toEqual({ updated: ['LARK_APP_ID', 'OWNERS'], added: ['LARK_APP_SECRET', 'LARK_DOMAIN'] });
    expect(readFileSync(file, 'utf-8')).toBe(`# config\nexport LARK_APP_ID=cli_x\nOTHER=1\nOWNERS=on_a,on_b\nLARK_APP_SECRET=${SECRET}\nLARK_DOMAIN=feishu\n`);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
