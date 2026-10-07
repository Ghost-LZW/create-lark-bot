/**
 * 单测 src/register-app.ts — 扫码建应用包装层。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 必须 hoist 到 vi.mock 工厂里; vitest 不允许工厂函数引用顶层变量.
vi.mock('@larksuiteoapi/node-sdk', () => ({
  registerApp: vi.fn(),
}));

vi.mock('qrcode-terminal', () => ({
  default: { generate: (_: string, _opts: unknown, cb?: (q: string) => void) => cb?.('FAKE-QR') },
}));

import { registerApp } from '@larksuiteoapi/node-sdk';
import { buildSdkAddons, buildSdkAppPreset, registerLarkApp } from '../src/register-app.js';
import { composePresets } from '../src/presets.js';

const mockedRegisterApp = registerApp as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedRegisterApp.mockReset();
});

describe('registerLarkApp', () => {
  it('returns ok with appId+secret on success (feishu tenant)', async () => {
    mockedRegisterApp.mockResolvedValue({
      client_id: 'cli_test_feishu',
      client_secret: 'secret-feishu-xxx',
      user_info: { tenant_brand: 'feishu', open_id: 'ou_abc123' },
    });

    const r = await registerLarkApp({ onQRCodeReady: () => {}, onStatusChange: () => {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.appId).toBe('cli_test_feishu');
      expect(r.appSecret).toBe('secret-feishu-xxx');
      expect(r.brand).toBe('feishu');
      expect(r.userOpenId).toBe('ou_abc123');
    }
  });

  it('defaults SDK source to create-lark-bot and honors override', async () => {
    mockedRegisterApp.mockResolvedValue({ client_id: 'cli_x', client_secret: 'sec', user_info: {} });
    await registerLarkApp({ onQRCodeReady: () => {}, onStatusChange: () => {} });
    expect(mockedRegisterApp.mock.calls[0][0]).toMatchObject({ source: 'create-lark-bot' });

    await registerLarkApp({ source: 'my-app', onQRCodeReady: () => {}, onStatusChange: () => {} });
    expect(mockedRegisterApp.mock.calls[1][0]).toMatchObject({ source: 'my-app' });
  });

  it('passes through scanner open_id (only when prefixed with ou_)', async () => {
    mockedRegisterApp.mockResolvedValueOnce({
      client_id: 'cli_x', client_secret: 'sec', user_info: { open_id: 'ou_valid_xxx' },
    });
    const r1 = await registerLarkApp({ onQRCodeReady: () => {}, onStatusChange: () => {} });
    expect(r1.ok && r1.userOpenId).toBe('ou_valid_xxx');

    mockedRegisterApp.mockResolvedValueOnce({
      client_id: 'cli_x', client_secret: 'sec', user_info: { open_id: 'weird_no_prefix' },
    });
    const r2 = await registerLarkApp({ onQRCodeReady: () => {}, onStatusChange: () => {} });
    expect(r2.ok && r2.userOpenId).toBeUndefined();
  });

  it('returns brand=lark when SDK reports tenant_brand=lark', async () => {
    mockedRegisterApp.mockResolvedValue({
      client_id: 'cli_lark',
      client_secret: 'lark-secret',
      user_info: { tenant_brand: 'lark' },
    });
    const r = await registerLarkApp({ onQRCodeReady: () => {}, onStatusChange: () => {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.brand).toBe('lark');
  });

  it('maps SDK device-flow error codes to structured errors', async () => {
    const cases: Array<[string, string]> = [
      ['abort', 'aborted'],
      ['expired_token', 'expired'],
      ['access_denied', 'denied'],
    ];
    for (const [code, expected] of cases) {
      mockedRegisterApp.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      const r = await registerLarkApp({ onQRCodeReady: () => {}, onStatusChange: () => {} });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe(expected);
    }
  });

  it('classifies network errors as network', async () => {
    mockedRegisterApp.mockRejectedValue(new Error('connect ETIMEDOUT 10.0.0.1:443'));
    const r = await registerLarkApp({ onQRCodeReady: () => {}, onStatusChange: () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('network');
  });

  it('falls through to unknown for unmapped errors and masks long tokens in message', async () => {
    mockedRegisterApp.mockRejectedValue(new Error('weird abcdefghijklmnopqrstuvwxyz1234567890_xyz error'));
    const r = await registerLarkApp({ onQRCodeReady: () => {}, onStatusChange: () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('unknown');
      expect(r.message).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
      expect(r.message).toContain('***');
    }
  });

  it('treats missing client_id/secret in successful response as unknown error', async () => {
    mockedRegisterApp.mockResolvedValue({ client_id: '', client_secret: '' });
    const r = await registerLarkApp({ onQRCodeReady: () => {}, onStatusChange: () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('unknown');
  });

  it('passes appPreset / addons / appId / createOnly through to the SDK', async () => {
    mockedRegisterApp.mockResolvedValue({ client_id: 'cli_x', client_secret: 'sec', user_info: {} });
    const addons = buildSdkAddons(composePresets('messagingCore'));
    await registerLarkApp({
      onQRCodeReady: () => {},
      appPreset: { name: "{user}'s bot", desc: 'd', avatar: 'https://img.example/a.png' },
      addons,
      createOnly: true,
    });
    expect(mockedRegisterApp.mock.calls[0][0]).toMatchObject({
      appPreset: { name: "{user}'s bot", desc: 'd', avatar: 'https://img.example/a.png' },
      addons: {
        scopes: { tenant: ['im:message:send_as_bot', 'im:message', 'im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly'] },
        events: { items: { tenant: ['im.message.receive_v1'] } },
        callbacks: { items: ['card.action.trigger'] },
      },
      createOnly: true,
    });
    expect(mockedRegisterApp.mock.calls[0][0]).not.toHaveProperty('appId');

    await registerLarkApp({ onQRCodeReady: () => {}, appId: 'cli_existing' });
    expect(mockedRegisterApp.mock.calls[1][0]).toMatchObject({ appId: 'cli_existing' });
  });
});

describe('SDK preset/addons builders', () => {
  it('maps identity to appPreset; local avatars are reported, not passed', () => {
    expect(buildSdkAppPreset({ name: ' Bot ', description: 'D', avatar: 'https://img.example/a.png' })).toEqual({
      appPreset: { name: 'Bot', desc: 'D', avatar: 'https://img.example/a.png' }, warnings: [],
    });
    const local = buildSdkAppPreset({ avatar: './me.png' });
    expect(local.appPreset).toBeUndefined();
    expect(local.warnings[0]).toMatch(/URL/);
    expect(buildSdkAppPreset(undefined)).toEqual({ warnings: [] });
  });

  it('maps a manifest to addons with user buckets; empty → undefined unless preset:false', () => {
    const addons = buildSdkAddons(composePresets('vcMeeting'));
    expect(addons?.events?.items).toEqual({
      tenant: ['vc.bot.meeting_invited_v1', 'vc.bot.meeting_activity_v1', 'vc.bot.meeting_ended_v1'],
      user: ['vc.meeting.participant_meeting_joined_v1'],
    });
    expect(addons?.scopes?.user).toEqual(['vc:meeting.meetingevent:read']);
    const empty = composePresets();
    expect(buildSdkAddons(empty)).toBeUndefined();
    expect(buildSdkAddons(empty, { preset: false })).toEqual({ preset: false });
  });
});
