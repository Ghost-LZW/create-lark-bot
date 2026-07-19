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
import { registerLarkApp } from '../src/register-app.js';

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
});
