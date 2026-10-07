import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseCliArgs, runCli, type CliIO } from '../src/cli.js';

const SECRET = 'app-secret-value-0123456789abcdef';

function io(overrides: Partial<CliIO> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out, err,
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: {}, isTTY: false, ...overrides } as CliIO,
  };
}

const created = {
  ok: true as const, appId: 'cli_c', appSecret: SECRET, brand: 'feishu' as const, source: 'console' as const,
  identity: { name: 'Ops Bot' },
  owner: { status: 'verified' as const, unionId: 'on_1', openId: 'ou_1', verified: { unionId: true, openId: true }, source: 'session_email' as const },
  validation: { ok: true as const, tenantAccessToken: 'tenant-token-should-not-leak-123456', tokenExpiresIn: 7200 },
  configuration: { ok: true, scopeCount: 1, skippedScopeCount: 0, droppedScopes: [], privilegeRangeCount: 0, subscribedEventCount: 2, missingEvents: [], missingCallbacks: [], eventModeReady: true, redirectConfigured: true, versionId: 'v1', sessionFile: '', sessionSource: 'cache', cookieCount: 1 } as any,
  warnings: [],
};

describe('parseCliArgs', () => {
  it('parses identity, presets, extras, outputs', () => {
    const a = parseCliArgs(['create', '--name', 'Ops Bot', '--desc', 'd', '--avatar', './a.png', '--preset', 'messagingCore,contact', '--scope', 'docx:document:readonly',
      '--event', 'x.y_v1', '--callback', 'card.action.trigger', '--redirect-url', 'http://x/cb', '--write-env', '.env', '--env-owner-var', 'OWNERS', '--json', '--compat']);
    expect(a).toMatchObject({ command: 'create', name: 'Ops Bot', desc: 'd', avatar: './a.png', presets: ['messagingCore', 'contact'], scopes: ['docx:document:readonly'],
      events: ['x.y_v1'], callbacks: ['card.action.trigger'], redirectUrls: ['http://x/cb'], writeEnv: '.env', envOwnerVar: 'OWNERS', json: true, mode: 'sdk', errors: [] });
  });

  it('reports bad input', () => {
    expect(parseCliArgs(['--preset', 'nope']).errors[0]).toMatch(/未知 preset/);
    expect(parseCliArgs(['--brand', 'x']).errors[0]).toMatch(/feishu 或 lark/);
    expect(parseCliArgs(['--name']).errors[0]).toMatch(/需要一个参数/);
    expect(parseCliArgs(['--wat']).errors[0]).toMatch(/未知参数/);
  });
});

describe('runCli', () => {
  it('create --json: machine-readable result on stdout without the secret or tenant token; files 0600', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'create-lark-bot-'));
    const env = join(dir, '.env');
    const out = join(dir, 'creds', 'app.json');
    const createLarkBot = vi.fn().mockResolvedValue(created);
    const t = io({ createLarkBot });
    const code = await runCli(['--name', 'Ops Bot', '--avatar', 'https://img/a.png', '--preset', 'messagingCore', '--scope', 'docx:document:readonly',
      '--json', '--write-env', env, '--env-owner-var', 'OWNERS', '--owner-prefix', 'lark-bot:', '--out', out], t.io);
    expect(code).toBe(0);
    const opts = createLarkBot.mock.calls[0][0];
    expect(opts.identity).toEqual({ name: 'Ops Bot', avatar: 'https://img/a.png' });
    expect(opts.presets).toEqual(['messagingCore', { scopes: { tenant: ['docx:document:readonly'], user: [] }, events: { app: [] }, callbacks: [] }]);

    expect(t.out).toHaveLength(1);
    const parsed = JSON.parse(t.out[0]);
    expect(parsed).toMatchObject({ ok: true, appId: 'cli_c', owner: { unionId: 'on_1' }, envFile: env, credentialsFile: out });
    expect(t.out[0]).not.toContain(SECRET);
    expect(t.out[0]).not.toContain('tenant-token-should-not-leak');
    expect(t.err.join('\n')).not.toContain(SECRET);

    expect(readFileSync(env, 'utf-8')).toBe(`LARK_APP_ID=cli_c\nLARK_APP_SECRET=${SECRET}\nLARK_DOMAIN=feishu\nOWNERS=lark-bot:on_1\n`);
    expect(JSON.parse(readFileSync(out, 'utf-8'))).toMatchObject({ appId: 'cli_c', appSecret: SECRET, owner: { unionId: 'on_1' } });
    if (process.platform !== 'win32') {
      expect(statSync(env).mode & 0o777).toBe(0o600);
      expect(statSync(out).mode & 0o777).toBe(0o600);
    }
  });

  it('--qr-out writes the login and device-flow QR contents to a 0600 file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'create-lark-bot-'));
    const qr = join(dir, 'qr.txt');
    const create = vi.fn(async (opts: any) => {
      await opts.session.onQrCode({ qrText: '[qr]', qrPayload: 'login-payload' });
      expect(readFileSync(qr, 'utf8')).toBe('login-payload\n');
      opts.register.onQRCodeReady({ url: 'https://accounts.example/verify?code=1', expireIn: 600 });
      return created;
    });
    const t = io({ createLarkBot: create });
    await runCli(['--out', join(dir, 'a.json'), '--qr-out', qr], t.io);
    expect(readFileSync(qr, 'utf8')).toBe('https://accounts.example/verify?code=1\n');
    expect(statSync(qr).mode & 0o777).toBe(0o600);
    expect(t.err.join('\n')).toContain('[qr]');
  });

  it('prints the secret only with --print-secret', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'create-lark-bot-'));
    const t = io({ createLarkBot: vi.fn().mockResolvedValue(created) });
    await runCli(['--out', join(dir, 'a.json')], t.io);
    expect(t.out.join('\n')).not.toContain(SECRET);
    const t2 = io({ createLarkBot: vi.fn().mockResolvedValue(created) });
    await runCli(['--out', join(dir, 'b.json'), '--print-secret'], t2.io);
    expect(t2.out.join('\n')).toContain(SECRET);
  });

  it('create failure with an already-created app tells how to recover; exit 1', async () => {
    const t = io({ createLarkBot: vi.fn().mockResolvedValue({ ok: false, stage: 'create', error: 'api_error', message: 'x', appId: 'cli_half' }) });
    expect(await runCli([], t.io)).toBe(1);
    expect(t.err.join('\n')).toMatch(/update --app-id cli_half/);
  });

  it('update requires --app-id or --select and forwards identity', async () => {
    expect(await runCli(['update'], io().io)).toBe(2);
    const dir = mkdtempSync(join(tmpdir(), 'create-lark-bot-'));
    const updateLarkBot = vi.fn().mockResolvedValue({ ...created, source: 'console', name: 'New' });
    const t = io({ updateLarkBot });
    expect(await runCli(['update', '--app-id', 'cli_c', '--name', 'New', '--out', join(dir, 'a.json')], t.io)).toBe(0);
    expect(updateLarkBot.mock.calls[0][0]).toMatchObject({ appId: 'cli_c', identity: { name: 'New' }, allowRescan: false });
  });

  it('verify reads LARK_* env and returns 1 when a check fails', async () => {
    const verifyLarkBot = vi.fn().mockResolvedValue({ appId: 'cli_c', brand: 'lark', ok: false, checks: [{ id: 'bot', status: 'fail', detail: 'no bot' }], missingScopes: [], scopesJson: {}, links: {} });
    const t = io({ verifyLarkBot, env: { LARK_APP_ID: 'cli_c', LARK_APP_SECRET: SECRET, LARK_DOMAIN: 'lark' } });
    expect(await runCli(['verify', '--json', '--live'], t.io)).toBe(1);
    expect(verifyLarkBot.mock.calls[0][0]).toMatchObject({ appId: 'cli_c', appSecret: SECRET, brand: 'lark', live: true });
    expect(JSON.parse(t.out[0]).ok).toBe(false);
    expect(await runCli(['verify'], io().io)).toBe(2);
  });
});
