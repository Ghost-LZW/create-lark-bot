/**
 * One-call orchestration.
 *
 * `createLarkBot` (new app):
 *   - console path (default for feishu): ONE Web session (one scan, zero with a cached
 *     session) → create the app with your identity → read AppID/AppSecret → configure
 *     scopes / data ranges / events / callbacks / redirect / visibility → publish.
 *   - SDK path (`mode: 'sdk'`, `brand: 'lark'`, or automatic fallback): official
 *     `registerApp` device flow with `appPreset` (identity) + `addons` (manifest); for feishu
 *     tenants the console configuration then runs on the cached/new Web session.
 *
 * `updateLarkBot` (existing app): select/list via the console (or SDK `appId` update flow),
 * read the secret, optionally change name/description/avatar, re-apply configuration.
 *
 * Credentials are returned; no secret is ever printed, logged, or put in an error message.
 */
import { createFeishuOpenPlatformApp } from './create-app.js';
import { selectExistingApp, type SelectExistingAppOptions } from './existing-app.js';
import { IdentityError, loadAvatar, type AppIdentity } from './identity.js';
import { configureOpenPlatformApp, resolveRequestedManifest, type ConfigureAppOptions, type ConfigureAppResult } from './open-platform.js';
import { resolveOwnerIdentity, type OwnerIdentity } from './owner.js';
import type { BotPreset, PresetName, ScopeManifest } from './presets.js';
import {
  buildSdkAddons,
  buildSdkAppPreset,
  registerLarkApp,
  type RegisterAppOptions,
  type RegisterAppResult,
  type RegisterBrand,
} from './register-app.js';
import { updateOpenPlatformAppIdentity, type UpdateIdentityResult } from './update-app.js';
import { redactSecrets } from './util.js';
import { validateCredentials, type CredentialValidation } from './validate.js';
import type { WebSessionIdentity } from './console-client.js';
import type { WebSessionOptions } from './web-session.js';

/** What the bot should have (shared by the console and SDK paths). */
export interface ManifestOptions {
  presets?: Array<PresetName | BotPreset>;
  scopeManifest?: ScopeManifest;
  events?: string[];
  userEvents?: string[];
  callbacks?: string[];
}

export type CreateMode = 'auto' | 'console' | 'sdk';

export interface CreateLarkBotOptions extends ManifestOptions {
  /** Name / description / avatar. Neutral defaults when omitted. */
  identity?: AppIdentity;
  /**
   * - `auto` (default): console flow for feishu; SDK fallback when the console path fails
   *   before creating anything (`fallbackToSdk`); SDK directly when `brand: 'lark'`.
   * - `console`: console flow only.  - `sdk`: device flow only (compat mode).
   */
  mode?: CreateMode;
  /** Set `'lark'` for Lark international tenants (SDK path; console automation is feishu-only). */
  brand?: RegisterBrand;
  /** Auto mode: fall back to the SDK device flow when the console path fails without creating an app. Default true. */
  fallbackToSdk?: boolean;
  /** Web session options (cache file, forceQrLogin, disableQrLogin, QR/status callbacks, fetchImpl). */
  session?: WebSessionOptions;
  /** SDK device-flow options (QR/status callbacks, abort signal, source tag). */
  register?: RegisterAppOptions;
  /** Console configuration options (redirectUrls, visibility, publishVersion, …). Manifest fields here are 0.1.x-compatible. */
  configure?: Omit<ConfigureAppOptions, 'appId' | 'brand'>;
  /** Validate credentials (tenant_access_token). Default true. */
  validate?: boolean;
  /** Run console configuration after creation. Default true (skipped for lark with a warning). */
  autoConfigure?: boolean;
  /** Resolve the scanning user through the new app (union_id). Default true. */
  resolveOwner?: boolean;
  /** Refuse when the cached Web session belongs to another user/tenant. */
  expectedIdentity?: Pick<WebSessionIdentity, 'userId' | 'tenantId'>;
}

export interface CreatedIdentity {
  name?: string;
  description?: string;
  avatarSource?: 'file' | 'url' | 'bytes' | 'default' | 'platform';
}

export type CreateLarkBotResult =
  | {
      ok: true;
      appId: string;
      appSecret: string;
      brand: RegisterBrand;
      /** Which flow created the app. */
      source: 'console' | 'sdk';
      /** SDK path: scanner open_id — app-scoped and NOT verified; prefer `owner`. */
      userOpenId?: string;
      /** Console path: who the Web session belongs to. */
      sessionIdentity?: WebSessionIdentity;
      identity: CreatedIdentity;
      owner?: OwnerIdentity;
      validation?: CredentialValidation;
      configuration?: ConfigureAppResult;
      warnings: string[];
    }
  | {
      ok: false;
      stage: 'identity' | 'create' | 'register';
      error: string;
      message: string;
      /** The app exists although the run failed: recover it with `updateLarkBot({ appId })`, do not create another. */
      appId?: string;
    };

function manifestOptions(options: CreateLarkBotOptions | UpdateLarkBotOptions): ManifestOptions {
  const c = options.configure ?? {};
  return {
    presets: options.presets ?? c.presets,
    scopeManifest: options.scopeManifest ?? c.scopeManifest,
    events: options.events ?? c.events,
    userEvents: options.userEvents ?? c.userEvents,
    callbacks: options.callbacks ?? c.callbacks,
  };
}

/**
 * Console failures the SDK fallback would not fix (bad input / wrong account), or where showing
 * another QR would be wrong (the user did not scan the first one).
 */
const NO_SDK_FALLBACK = new Set<string>(['invalid_identity', 'session_changed', 'qr_expired', 'timeout']);

export async function createLarkBot(options: CreateLarkBotOptions = {}): Promise<CreateLarkBotResult> {
  const warnings: string[] = [];
  const mode: CreateMode = options.brand === 'lark' ? 'sdk' : options.mode ?? 'auto';
  const manifest = manifestOptions(options);
  const fetchImpl = options.session?.fetchImpl ?? options.configure?.fetchImpl;

  // Validate the identity BEFORE any QR is shown or anything is created.
  let identity = options.identity;
  if (mode !== 'sdk' && identity?.avatar !== undefined) {
    try {
      identity = { ...identity, avatar: (await loadAvatar(identity.avatar, { fetchImpl })).bytes };
    } catch (err) {
      return { ok: false, stage: 'identity', error: 'invalid_identity', message: err instanceof Error ? err.message : String(err) };
    }
  }

  if (mode !== 'sdk') {
    const created = await createFeishuOpenPlatformApp({
      ...options.session,
      ...(options.configure?.onStatus && !options.session?.onStatus ? { onStatus: options.configure.onStatus } : {}),
      ...(options.configure?.onQrCode && !options.session?.onQrCode ? { onQrCode: options.configure.onQrCode } : {}),
      identity,
      expectedIdentity: options.expectedIdentity,
    });
    if (created.ok) {
      warnings.push(...created.warnings);
      return finishCreated(options, {
        appId: created.appId,
        appSecret: created.appSecret,
        brand: 'feishu',
        source: 'console',
        sessionIdentity: created.sessionIdentity,
        identity: { name: created.identity.name, description: created.identity.description, avatarSource: created.identity.avatarSource },
        sessionFile: created.sessionFile,
      }, manifest, warnings);
    }
    const canFallBack = mode === 'auto'
      && options.fallbackToSdk !== false
      && !options.session?.disableQrLogin // the SDK flow always shows a QR
      && !created.appId
      && !NO_SDK_FALLBACK.has(created.reason);
    if (!canFallBack) {
      return {
        ok: false,
        stage: created.reason === 'invalid_identity' ? 'identity' : 'create',
        error: created.reason,
        message: created.message,
        ...(created.appId ? { appId: created.appId } : {}),
      };
    }
    warnings.push(`控制台一次扫码创建失败（${created.reason}: ${created.message}），已回退到 SDK 兼容模式`);
    await options.session?.onStatus?.(warnings[warnings.length - 1]);
  }

  // SDK device flow (compat / lark / fallback)
  const preset = buildSdkAppPreset(options.identity);
  warnings.push(...preset.warnings);
  const requested = resolveRequestedManifest(manifest);
  const registered: RegisterAppResult = await registerLarkApp({
    ...options.register,
    appPreset: options.register?.appPreset ?? preset.appPreset,
    addons: options.register?.addons ?? buildSdkAddons(requested),
    createOnly: options.register?.createOnly ?? true,
  });
  if (!registered.ok) {
    return { ok: false, stage: 'register', error: registered.error, message: registered.message };
  }
  return finishCreated(options, {
    appId: registered.appId,
    appSecret: registered.appSecret,
    brand: registered.brand,
    source: 'sdk',
    userOpenId: registered.userOpenId,
    identity: {
      ...(preset.appPreset?.name ? { name: preset.appPreset.name } : {}),
      ...(preset.appPreset?.desc ? { description: preset.appPreset.desc } : {}),
      avatarSource: 'platform',
    },
  }, manifest, warnings);
}

async function finishCreated(
  options: CreateLarkBotOptions,
  created: {
    appId: string;
    appSecret: string;
    brand: RegisterBrand;
    source: 'console' | 'sdk';
    userOpenId?: string;
    sessionIdentity?: WebSessionIdentity;
    identity: CreatedIdentity;
    sessionFile?: string;
  },
  manifest: ManifestOptions,
  warnings: string[],
): Promise<CreateLarkBotResult> {
  let validation: CredentialValidation | undefined;
  if (options.validate !== false) {
    validation = await validateCredentials(created.appId, created.appSecret, created.brand, { fetchImpl: options.session?.fetchImpl });
  }

  let configuration: ConfigureAppResult | undefined;
  if (options.autoConfigure !== false) {
    if (created.brand === 'lark') {
      warnings.push('Lark 国际版租户不支持控制台自动配置：权限/事件已通过 SDK addons 预填（平台灰度开启时生效），请用 verify 检查并到 open.larksuite.com 补齐');
    } else {
      const consoleSession = created.source === 'console';
      configuration = await configureOpenPlatformApp({
        ...options.session,
        ...options.configure,
        ...manifest,
        ...(consoleSession
          ? { sessionFilePath: created.sessionFile ?? options.session?.sessionFilePath, forceQrLogin: false, disableQrLogin: true }
          : {}),
        appId: created.appId,
        brand: 'feishu',
        appJustCreated: true,
      });
    }
  }

  const owner = options.resolveOwner === false
    ? undefined
    : await resolveOwnerIdentity({
        appId: created.appId,
        appSecret: created.appSecret,
        brand: created.brand,
        openId: created.userOpenId,
        email: created.sessionIdentity?.email,
        name: created.sessionIdentity?.userName,
        fetchImpl: options.session?.fetchImpl,
        ...(validation?.ok ? { tenantAccessToken: validation.tenantAccessToken } : {}),
      });

  return {
    ok: true,
    appId: created.appId,
    appSecret: created.appSecret,
    brand: created.brand,
    source: created.source,
    ...(created.userOpenId ? { userOpenId: created.userOpenId } : {}),
    ...(created.sessionIdentity ? { sessionIdentity: created.sessionIdentity } : {}),
    identity: created.identity,
    ...(owner ? { owner } : {}),
    validation,
    configuration,
    warnings: warnings.map(w => redactSecrets(w, [created.appSecret])),
  };
}

// ─── existing app ────────────────────────────────────────────────────────────

export interface UpdateLarkBotOptions extends ManifestOptions {
  /** The app to update; omit and pass `pick` to choose from the list. */
  appId?: string;
  pick?: SelectExistingAppOptions['pick'];
  /** Re-scan once automatically (true) or after asking (function) when the session expired. */
  allowRescan?: SelectExistingAppOptions['allowRescan'];
  /** Change name / description / avatar (published as a new version). */
  identity?: AppIdentity;
  /** `sdk`: official update-existing-app device flow (required for Lark tenants). Default `console`. */
  mode?: 'console' | 'sdk';
  brand?: RegisterBrand;
  session?: WebSessionOptions;
  register?: RegisterAppOptions;
  configure?: Omit<ConfigureAppOptions, 'appId' | 'brand'>;
  validate?: boolean;
  /** Re-apply the manifest / redirect / visibility. Default true. */
  autoConfigure?: boolean;
  resolveOwner?: boolean;
}

export type UpdateLarkBotResult =
  | {
      ok: true;
      appId: string;
      appSecret: string;
      brand: RegisterBrand;
      source: 'console' | 'sdk';
      name?: string;
      sessionIdentity?: WebSessionIdentity;
      identityUpdate?: UpdateIdentityResult;
      owner?: OwnerIdentity;
      validation?: CredentialValidation;
      configuration?: ConfigureAppResult;
      /** A fresh QR login was needed because the cached session had expired. */
      rescanned?: boolean;
      warnings: string[];
    }
  | { ok: false; stage: 'select' | 'identity' | 'register'; error: string; message: string };

export async function updateLarkBot(options: UpdateLarkBotOptions): Promise<UpdateLarkBotResult> {
  const warnings: string[] = [];
  const manifest = manifestOptions(options);
  const fetchImpl = options.session?.fetchImpl;
  const mode = options.brand === 'lark' ? 'sdk' : options.mode ?? 'console';

  if (mode === 'sdk') {
    if (!options.appId) return { ok: false, stage: 'select', error: 'missing_app_id', message: 'SDK 更新流程需要 appId' };
    const preset = buildSdkAppPreset(options.identity);
    warnings.push(...preset.warnings);
    const registered = await registerLarkApp({
      ...options.register,
      appId: options.appId,
      createOnly: false,
      appPreset: options.register?.appPreset ?? preset.appPreset,
      addons: options.register?.addons ?? buildSdkAddons(resolveRequestedManifest(manifest)),
    });
    if (!registered.ok) return { ok: false, stage: 'register', error: registered.error, message: registered.message };
    const validation = options.validate === false ? undefined : await validateCredentials(registered.appId, registered.appSecret, registered.brand);
    const owner = options.resolveOwner === false ? undefined : await resolveOwnerIdentity({
      appId: registered.appId, appSecret: registered.appSecret, brand: registered.brand, openId: registered.userOpenId,
      ...(validation?.ok ? { tenantAccessToken: validation.tenantAccessToken } : {}),
    });
    return {
      ok: true, appId: registered.appId, appSecret: registered.appSecret, brand: registered.brand, source: 'sdk',
      ...(owner ? { owner } : {}), validation, warnings,
    };
  }

  // Validate the new identity before touching anything.
  let identity = options.identity;
  if (identity?.avatar !== undefined) {
    try {
      identity = { ...identity, avatar: (await loadAvatar(identity.avatar, { fetchImpl })).bytes };
    } catch (err) {
      return { ok: false, stage: 'identity', error: 'invalid_identity', message: err instanceof IdentityError ? err.message : String(err) };
    }
  }

  const selected = await selectExistingApp({
    ...options.session,
    appId: options.appId,
    pick: options.pick,
    allowRescan: options.allowRescan,
  });
  if (!selected.ok) return { ok: false, stage: 'select', error: selected.reason, message: selected.message };

  let identityUpdate: UpdateIdentityResult | undefined;
  if (identity && (identity.name !== undefined || identity.description !== undefined || identity.avatar !== undefined)) {
    identityUpdate = await updateOpenPlatformAppIdentity(selected.client, selected.appId, identity, {
      userName: selected.sessionIdentity?.userName,
      fetchImpl,
    });
    if (!identityUpdate.ok) warnings.push(`更新名称/描述/头像失败（${identityUpdate.reason}）: ${identityUpdate.message}`);
  }

  const validation = options.validate === false ? undefined : await validateCredentials(selected.appId, selected.appSecret, 'feishu', { fetchImpl });
  let configuration: ConfigureAppResult | undefined;
  if (options.autoConfigure !== false) {
    configuration = await configureOpenPlatformApp({
      ...options.session,
      ...options.configure,
      ...manifest,
      sessionFilePath: selected.sessionFile,
      forceQrLogin: false,
      disableQrLogin: true,
      appId: selected.appId,
      brand: 'feishu',
    });
  }
  const owner = options.resolveOwner === false ? undefined : await resolveOwnerIdentity({
    appId: selected.appId,
    appSecret: selected.appSecret,
    brand: 'feishu',
    email: selected.sessionIdentity?.email,
    name: selected.sessionIdentity?.userName,
    fetchImpl,
    ...(validation?.ok ? { tenantAccessToken: validation.tenantAccessToken } : {}),
  });
  return {
    ok: true,
    appId: selected.appId,
    appSecret: selected.appSecret,
    brand: 'feishu',
    source: 'console',
    name: identityUpdate?.ok && identityUpdate.changed.includes('name') && identity?.name ? identity.name : selected.app.name,
    ...(selected.sessionIdentity ? { sessionIdentity: selected.sessionIdentity } : {}),
    ...(identityUpdate ? { identityUpdate } : {}),
    ...(owner ? { owner } : {}),
    validation,
    configuration,
    rescanned: selected.rescanned,
    warnings: warnings.map(w => redactSecrets(w, [selected.appSecret])),
  };
}
