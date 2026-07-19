/**
 * 一键建 bot 编排：扫码① 建应用拿凭证 → 校验凭证 → 扫码②（或复用缓存 session，
 * 0 扫码）自动配置开放平台（权限含 VC、事件订阅、redirect、发布版本）。
 */
import { registerLarkApp, type RegisterAppOptions, type RegisterAppResult, type RegisterBrand } from './register-app.js';
import { configureOpenPlatformApp, type ConfigureAppOptions, type ConfigureAppResult } from './open-platform.js';
import { validateCredentials, type CredentialValidation } from './validate.js';

export interface CreateLarkBotOptions {
  /** 扫码① 建应用的选项（二维码/状态回调、取消信号）。 */
  register?: RegisterAppOptions;
  /** 扫码② 开放平台自动配置的选项（appId/brand 由建应用结果注入，无需传）。 */
  configure?: Omit<ConfigureAppOptions, 'appId' | 'brand'>;
  /** 是否在建应用后校验凭证（取一次 tenant_access_token），默认 true。 */
  validate?: boolean;
  /** 是否执行开放平台自动配置，默认 true。Lark 国际版租户会自动跳过并给出提示。 */
  autoConfigure?: boolean;
}

export type CreateLarkBotResult =
  | {
      ok: true;
      appId: string;
      appSecret: string;
      brand: RegisterBrand;
      userOpenId?: string;
      /** 凭证校验结果（validate=false 时为 undefined）。 */
      validation?: CredentialValidation;
      /** 开放平台自动配置结果（跳过 / lark 租户时为 undefined）。失败不影响 ok——凭证已到手。 */
      configuration?: ConfigureAppResult;
    }
  | {
      ok: false;
      stage: 'register';
      error: Extract<RegisterAppResult, { ok: false }>['error'];
      message: string;
    };

/**
 * 全程最多两次扫码创建一个可用的飞书 bot 应用。
 * 返回 ok=true 即拿到 AppID/AppSecret；开放平台配置失败只体现在
 * `configuration.ok === false`，调用方可提示用户手动补齐。
 */
export async function createLarkBot(options: CreateLarkBotOptions = {}): Promise<CreateLarkBotResult> {
  const registered = await registerLarkApp(options.register);
  if (!registered.ok) {
    return { ok: false, stage: 'register', error: registered.error, message: registered.message };
  }

  let validation: CredentialValidation | undefined;
  if (options.validate !== false) {
    validation = await validateCredentials(registered.appId, registered.appSecret, registered.brand);
  }

  let configuration: ConfigureAppResult | undefined;
  if (options.autoConfigure !== false) {
    configuration = await configureOpenPlatformApp({
      ...options.configure,
      appId: registered.appId,
      brand: registered.brand,
    });
  }

  return {
    ok: true,
    appId: registered.appId,
    appSecret: registered.appSecret,
    brand: registered.brand,
    userOpenId: registered.userOpenId,
    validation,
    configuration,
  };
}
