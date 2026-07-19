/**
 * 单测 createLarkBot 编排：建应用 → 校验 → 自动配置的串联与降级。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/register-app.js', () => ({ registerLarkApp: vi.fn() }));
vi.mock('../src/open-platform.js', () => ({ configureOpenPlatformApp: vi.fn() }));
vi.mock('../src/validate.js', () => ({ validateCredentials: vi.fn() }));

import { createLarkBot } from '../src/create-bot.js';
import { registerLarkApp } from '../src/register-app.js';
import { configureOpenPlatformApp } from '../src/open-platform.js';
import { validateCredentials } from '../src/validate.js';

const mockedRegister = registerLarkApp as unknown as ReturnType<typeof vi.fn>;
const mockedConfigure = configureOpenPlatformApp as unknown as ReturnType<typeof vi.fn>;
const mockedValidate = validateCredentials as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedRegister.mockReset();
  mockedConfigure.mockReset();
  mockedValidate.mockReset();
});

describe('createLarkBot', () => {
  it('chains register → validate → configure and passes appId/brand through', async () => {
    mockedRegister.mockResolvedValue({
      ok: true, appId: 'cli_a', appSecret: 'sec', brand: 'feishu', userOpenId: 'ou_1',
    });
    mockedValidate.mockResolvedValue({ ok: true, tenantAccessToken: 't', tokenExpiresIn: 7200 });
    mockedConfigure.mockResolvedValue({ ok: true, scopeCount: 5, subscribedEventCount: 9 });

    const result = await createLarkBot({ configure: { redirectUrls: ['http://x/cb'] } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.appId).toBe('cli_a');
      expect(result.validation?.ok).toBe(true);
      expect(result.configuration?.ok).toBe(true);
    }
    expect(mockedValidate).toHaveBeenCalledWith('cli_a', 'sec', 'feishu');
    expect(mockedConfigure).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'cli_a', brand: 'feishu', redirectUrls: ['http://x/cb'] }),
    );
  });

  it('returns register failure without touching validate/configure', async () => {
    mockedRegister.mockResolvedValue({ ok: false, error: 'expired', message: '二维码已过期' });
    const result = await createLarkBot();
    expect(result).toMatchObject({ ok: false, stage: 'register', error: 'expired' });
    expect(mockedValidate).not.toHaveBeenCalled();
    expect(mockedConfigure).not.toHaveBeenCalled();
  });

  it('still returns ok=true with credentials when auto-configure fails', async () => {
    mockedRegister.mockResolvedValue({ ok: true, appId: 'cli_a', appSecret: 'sec', brand: 'feishu' });
    mockedValidate.mockResolvedValue({ ok: true, tenantAccessToken: 't', tokenExpiresIn: 7200 });
    mockedConfigure.mockResolvedValue({ ok: false, reason: 'missing_csrf', message: 'no csrf' });

    const result = await createLarkBot();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.appSecret).toBe('sec');
      expect(result.configuration).toMatchObject({ ok: false, reason: 'missing_csrf' });
    }
  });

  it('skips validate and configure when disabled', async () => {
    mockedRegister.mockResolvedValue({ ok: true, appId: 'cli_a', appSecret: 'sec', brand: 'feishu' });
    const result = await createLarkBot({ validate: false, autoConfigure: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.validation).toBeUndefined();
      expect(result.configuration).toBeUndefined();
    }
    expect(mockedValidate).not.toHaveBeenCalled();
    expect(mockedConfigure).not.toHaveBeenCalled();
  });
});
