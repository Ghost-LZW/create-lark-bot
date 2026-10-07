/**
 * 兼容模式：官方 SDK device flow 扫码建应用 — 对接 `@larksuiteoapi/node-sdk` 的 `registerApp`
 * （≥ 1.74：`appPreset` 预填名称/描述/头像 URL，`addons` 预填 scopes/events/callbacks，
 * `appId` 走「更新已有应用」，`createOnly` 隐藏「选择已有应用」入口）。
 *
 * 主路径是 {@link createFeishuOpenPlatformApp}（控制台单 Web session）；这里用于 Lark
 * 国际版租户以及控制台路径不可用时的回退。
 *
 * 走 OAuth 2.0 Device Flow (RFC 8628):
 *   1. SDK 向 `accounts.feishu.cn/oauth/v1/app/registration` 发 `action=begin`
 *      请求 (`archetype=PersonalAgent`), 拿到 device_code + 二维码 URL
 *   2. 在终端渲染二维码 + 链接, 等用户扫码
 *   3. SDK 轮询同端点 `action=poll` 直到拿到 client_id + client_secret
 *      (=AppID + AppSecret)
 *
 * 注意:
 * - 端点 archetype 写死 `PersonalAgent`, 但 PersonalAgent 应用可以挂 bot 能力。
 * - 建出来的应用没有声明任何 scope；配合 {@link configureOpenPlatformApp}
 *   自动导入（第二个二维码 / 复用缓存 session 时 0 扫码）。
 * - secret 永远不打印; 错误只暴露 error code / 阶段标签, 不暴露 secret。
 *
 * 实现源自 botmux（https://github.com/deepcoldy/botmux，MIT）的
 * src/setup/register-app.ts。
 */
import { registerApp } from '@larksuiteoapi/node-sdk';
import qrcode from 'qrcode-terminal';
import { isHttpUrl, type AppIdentity } from './identity.js';
import type { BotManifest } from './presets.js';
import { redactSecrets } from './util.js';

/** SDK `AppPreset`: pre-filled on the creation page; the user may still edit it. */
export interface SdkAppPreset {
  /** 1–6 publicly reachable image URLs (png/jpg/jpeg/webp/gif); the first is selected. */
  avatar?: string | string[];
  /** Supports `{user}` (replaced with the scanning user's name by the platform). */
  name?: string;
  /** Supports `{user}`. */
  desc?: string;
}

/** SDK `AppAddons`: additive scopes/events/callbacks shown on the confirm page. */
export interface SdkAppAddons {
  /** false = drop the platform default template (minimal base: bot capability only). */
  preset?: boolean;
  scopes?: { tenant?: string[]; user?: string[] };
  events?: { items?: { tenant?: string[]; user?: string[] } };
  callbacks?: { items?: string[] };
}

/**
 * Map an {@link AppIdentity} to the SDK `appPreset`. Only URL avatars can be passed (the
 * platform page fetches them); a local file / bytes avatar is reported in `warnings`.
 */
export function buildSdkAppPreset(identity: AppIdentity | undefined): { appPreset?: SdkAppPreset; warnings: string[] } {
  const warnings: string[] = [];
  if (!identity) return { warnings };
  const preset: SdkAppPreset = {};
  if (identity.name?.trim()) preset.name = identity.name.trim();
  if (identity.description?.trim()) preset.desc = identity.description.trim();
  if (identity.avatar !== undefined) {
    if (typeof identity.avatar === 'string' && isHttpUrl(identity.avatar)) preset.avatar = identity.avatar.trim();
    else warnings.push('兼容模式（SDK device flow）只接受公网可访问的头像 URL；本地头像文件已忽略，可稍后用 update 流程设置');
  }
  return { appPreset: Object.keys(preset).length > 0 ? preset : undefined, warnings };
}

/** Map a composed manifest to SDK `addons` (undefined when empty, which the SDK rejects). */
export function buildSdkAddons(manifest: Pick<BotManifest, 'scopes' | 'events' | 'callbacks'>, opts: { preset?: boolean } = {}): SdkAppAddons | undefined {
  const addons: SdkAppAddons = {};
  if (opts.preset !== undefined) addons.preset = opts.preset;
  const tenant = manifest.scopes.tenant;
  const user = manifest.scopes.user;
  if (tenant.length || user.length) addons.scopes = { ...(tenant.length ? { tenant: [...tenant] } : {}), ...(user.length ? { user: [...user] } : {}) };
  const appEvents = manifest.events.app;
  const userEvents = manifest.events.user;
  if (appEvents.length || userEvents.length) {
    addons.events = { items: { ...(appEvents.length ? { tenant: [...appEvents] } : {}), ...(userEvents.length ? { user: [...userEvents] } : {}) } };
  }
  if (manifest.callbacks.length) addons.callbacks = { items: [...manifest.callbacks] };
  const hasItems = Boolean(addons.scopes || addons.events || addons.callbacks);
  if (!hasItems && addons.preset !== false) return undefined;
  return addons;
}

export type RegisterBrand = 'feishu' | 'lark';

export type RegisterAppOk = {
  ok: true;
  appId: string;
  appSecret: string;
  brand: RegisterBrand;
  /**
   * 扫码人的 open_id (device flow `request_user_info` 返回)。可用作默认管理员 /
   * 可见范围成员。接口没返回时为 undefined。
   */
  userOpenId?: string;
};

export type RegisterAppErr = {
  ok: false;
  /**
   * - `aborted`: 用户 Ctrl-C / 主动取消
   * - `expired`: 二维码过期 (默认 10 分钟)
   * - `denied`: 用户在浏览器里拒绝
   * - `network`: 网络错误 / 端点不可达
   * - `unknown`: 其它 (含 SDK 抛非预期错误)
   */
  error: 'aborted' | 'expired' | 'denied' | 'network' | 'unknown';
  /** 给用户看的简短错误描述, 不含 secret。 */
  message: string;
};

export type RegisterAppResult = RegisterAppOk | RegisterAppErr;

export interface RegisterAppOptions {
  /** 取消信号 (Ctrl-C 时填充)。 */
  signal?: AbortSignal;
  /** 上报给飞书的来源标识，默认 `create-lark-bot`。 */
  source?: string;
  /** 渲染前回调, 默认在 stderr 打印二维码 + 链接。 */
  onQRCodeReady?: (info: { url: string; expireIn: number }) => void;
  /** 状态变更回调, 主要用于"已切换到 Lark 域名"提示。 */
  onStatusChange?: (info: { status: string; interval?: number }) => void;
  /** 创建页预填的名称/描述/头像 URL（SDK `appPreset`）。 */
  appPreset?: SdkAppPreset;
  /** 确认页预填的增量 scopes/events/callbacks（SDK `addons`；平台灰度未开时被忽略）。 */
  addons?: SdkAppAddons;
  /** 更新已有应用（cli_xxx）的配置而不是新建：确认页展示 addons 带来的差异。 */
  appId?: string;
  /** 只允许新建（隐藏「选择已有应用」入口）；优先于 appId。 */
  createOnly?: boolean;
}

function defaultPrintQRCode(info: { url: string; expireIn: number }): void {
  const mins = Math.max(1, Math.round(info.expireIn / 60));
  process.stderr.write('\n请用飞书 App 扫码完成应用创建：\n\n');
  qrcode.generate(info.url, { small: true }, qr => process.stderr.write(qr + '\n'));
  process.stderr.write(`\n二维码有效期约 ${mins} 分钟。也可在浏览器打开：\n  ${info.url}\n\n`);
}

function defaultPrintStatus(info: { status: string; interval?: number }): void {
  if (info.status === 'domain_switched') {
    process.stderr.write('识别到国际版租户, 已切换到 larksuite.com 域名继续轮询。\n');
  } else if (info.status === 'slow_down' && info.interval) {
    process.stderr.write(`轮询过快, 间隔自动调整到 ${info.interval}s。\n`);
  }
}

/**
 * 尝试扫码建应用。任何失败都返回 RegisterAppErr (不抛), 调用方可以回退手动粘贴。
 *
 * Secret 安全约束:
 * - SDK 返回的 client_secret 只放进返回值, 不打印, 不写日志
 * - 错误链里只放错误 code / 阶段, 不带 secret
 */
export async function registerLarkApp(opts: RegisterAppOptions = {}): Promise<RegisterAppResult> {
  const onQR = opts.onQRCodeReady ?? defaultPrintQRCode;
  const onStatus = opts.onStatusChange ?? defaultPrintStatus;

  try {
    const result = await registerApp({
      signal: opts.signal,
      source: opts.source ?? 'create-lark-bot',
      onQRCodeReady: onQR,
      onStatusChange: onStatus,
      ...(opts.appPreset ? { appPreset: opts.appPreset } : {}),
      ...(opts.addons ? { addons: opts.addons } : {}),
      ...(opts.appId ? { appId: opts.appId } : {}),
      ...(opts.createOnly !== undefined ? { createOnly: opts.createOnly } : {}),
    });

    if (!result.client_id || !result.client_secret) {
      return { ok: false, error: 'unknown', message: 'SDK 返回的 client_id/client_secret 为空' };
    }

    const brand: RegisterBrand = result.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu';
    const userOpenId =
      typeof result.user_info?.open_id === 'string' && result.user_info.open_id.startsWith('ou_')
        ? result.user_info.open_id
        : undefined;

    return { ok: true, appId: result.client_id, appSecret: result.client_secret, brand, userOpenId };
  } catch (err: any) {
    // SDK 抛 LarkChannelError, code 字段对齐 RFC 8628 的 device flow 错误
    const code: string = err?.code ?? '';
    const rawMsg: string = err?.message ?? String(err);
    // SDK 不会把 secret 放进 message, 但保险起见再过一次
    const safeMsg = redactSecrets(rawMsg);

    if (code === 'abort') return { ok: false, error: 'aborted', message: '用户取消扫码' };
    if (code === 'expired_token') return { ok: false, error: 'expired', message: '二维码已过期, 请重试' };
    if (code === 'access_denied') return { ok: false, error: 'denied', message: '用户在浏览器里拒绝授权' };

    if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET|network/i.test(rawMsg)) {
      return { ok: false, error: 'network', message: `网络错误: ${safeMsg}` };
    }

    return { ok: false, error: 'unknown', message: safeMsg };
  }
}
