/**
 * Create a Feishu app through the Open Platform console with one Web session
 * (one QR scan, or zero with a cached session), with a caller-chosen identity.
 *
 * Chain (ported from botmux createFeishuOpenPlatformApp / createOpenPlatformAppWithClient,
 * botmux commits 59d27e43, b6694de8, 7f5b53eb, e9763bd9, 973b6c98):
 *   1. upload the icon → `url`
 *   2. `manifest/upsert_by_template` (the console's one-click agent template: bot capability,
 *      long-connection events/callbacks out of the box). Only a *definite* rejection
 *      (business code≠0 or HTTP 404) falls back to plain `app/create`; an unknown outcome
 *      (transport error, 5xx, code=0 without ClientID) fails closed — never risk a duplicate app.
 *   3. `robot/switch` + `event/switch` (long connection), idempotent → retried on blips
 *   4. narrow required privilege data ranges (non-fatal)
 *   5. version 1.0.0 visible to the creator + `publish/commit` → app is enabled
 *   6. read the AppSecret (read-only `secret/<id>`, never `secret/reset`)
 *
 * Any failure after the app exists is reported WITH the appId, so callers never create a
 * second app; recover with {@link fetchOpenPlatformAppSecret} / the existing-app flow.
 */
import { randomUUID } from 'node:crypto';
import {
  createOpenPlatformApiClient,
  OpenPlatformApiError,
  type OpenPlatformApiClient,
  type WebSessionIdentity,
} from './console-client.js';
import {
  buildAppVersionCreatePayload,
  extractVersionId,
  narrowRequiredPrivilegeRanges,
  LONG_CONNECTION_EVENT_MODE,
} from './console-ops.js';
import {
  applyUserPlaceholder,
  IdentityError,
  DEFAULT_APP_DESCRIPTION,
  DEFAULT_APP_NAME,
  loadAvatar,
  pickAvailableName,
  validateAppName,
  AVATAR_IMAGE_SIZE,
  type AppIdentity,
} from './identity.js';
import { asRecord, pickPayloadString, pickString, safeErrorMessage } from './util.js';
import { prepareWebSession, type WebSessionFailureReason, type WebSessionOptions, type WebSessionSource } from './web-session.js';

/** Console launcher template id for "one-click create agent". */
export const ONECLICK_APP_MANIFEST_TEMPLATE_ID = 'developer_console';

export function buildManifestTemplateCreatePayload(name: string, description: string, avatar: string, cid: string) {
  return {
    appManifestTemplateID: ONECLICK_APP_MANIFEST_TEMPLATE_ID,
    createAppUserCustomField: {
      i18n: { zh_cn: { name, description } },
      avatar,
      primaryLang: 'zh_cn',
    },
    cid,
    HTTPHead: {},
  };
}

export function buildPlainAppCreatePayload(name: string, description: string, avatar: string) {
  return {
    appSceneType: 0, // SelfBuild
    name,
    desc: description,
    avatar,
    i18n: { zh_cn: { name, description } },
    primaryLang: 'zh_cn',
  };
}

/** Upload PNG bytes as an app icon; returns the console URL to put in `avatar`. */
export async function uploadAppIcon(client: OpenPlatformApiClient, png: Uint8Array, fileName = 'icon.png'): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), fileName);
  form.append('uploadType', '4'); // console enum: Icon
  form.append('isIsv', 'false'); // self-built (enterprise) app
  form.append('scale', JSON.stringify({ width: AVATAR_IMAGE_SIZE, height: AVATAR_IMAGE_SIZE }));
  const uploaded = await client.postForm('/developers/v1/app/upload/image', form);
  const url = pickPayloadString(uploaded, ['url']);
  if (!url) throw new Error('开放平台上传图标后没有返回 url');
  return url;
}

/** Business rejection or 404 ⟹ the app definitely was not created; anything else is "unknown". */
function isDefiniteTemplateRejection(err: unknown): boolean {
  if (!(err instanceof OpenPlatformApiError)) return false;
  const code = asRecord(err.payload).code;
  if (typeof code === 'number' && code !== 0) return true;
  return err.status === 404;
}

export class CreatedOpenPlatformAppError extends Error {
  constructor(readonly appId: string, cause: unknown) {
    super(`应用 ${appId} 已创建，但启用机器人能力 / 发布 / 读取 AppSecret 失败: ${safeErrorMessage(cause)}`);
    this.name = 'CreatedOpenPlatformAppError';
  }
}

export interface ResolvedIdentity {
  name: string;
  description: string;
  /** Console icon URL after upload. */
  avatarUrl: string;
  avatarSource: 'file' | 'url' | 'bytes' | 'default';
}

export interface CreateWithClientOptions {
  identity?: AppIdentity;
  /** Console user id of the creator: the first version must be visible to them to auto-enable. */
  creatorUserId: string;
  /** Display name used for `{user}`. */
  creatorName?: string;
  /** Names already used (for the default-name suffix). When omitted the console list is read. */
  takenNames?: string[];
  fetchImpl?: typeof fetch;
  onStatus?: (message: string) => void | Promise<void>;
}

/** Resolve name/description/avatar for the console path (the avatar is uploaded here). */
export async function resolveConsoleIdentity(
  client: OpenPlatformApiClient,
  options: Pick<CreateWithClientOptions, 'identity' | 'creatorName' | 'takenNames' | 'fetchImpl'>,
): Promise<ResolvedIdentity> {
  const identity = options.identity ?? {};
  let name = applyUserPlaceholder(identity.name?.trim() ?? '', options.creatorName);
  if (!name) {
    let taken = options.takenNames;
    if (!taken) {
      try {
        taken = (await listOpenPlatformAppsInternal(client)).map(app => app.name);
      } catch {
        taken = [];
      }
    }
    name = pickAvailableName(DEFAULT_APP_NAME, taken);
  }
  const nameError = validateAppName(name);
  if (nameError) throw new IdentityError(nameError);
  const description = applyUserPlaceholder(identity.description?.trim() || DEFAULT_APP_DESCRIPTION, options.creatorName);
  const avatar = await loadAvatar(identity.avatar, { fetchImpl: options.fetchImpl });
  const avatarUrl = await uploadAppIcon(client, avatar.bytes);
  return { name, description, avatarUrl, avatarSource: avatar.source };
}

export async function createOpenPlatformAppWithClient(
  client: OpenPlatformApiClient,
  options: CreateWithClientOptions,
): Promise<{ appId: string; appSecret: string; identity: ResolvedIdentity; usedTemplate: boolean; privilegeRangeWarning?: string }> {
  if (!options.creatorUserId) throw new Error('创建应用缺少创建者 userId，无法完成上架启用');
  const resolved = await resolveConsoleIdentity(client, options);
  await options.onStatus?.(`正在创建应用「${resolved.name}」…`);

  let appId: string | undefined;
  let usedTemplate = true;
  try {
    const created = await client.postJson(
      '/developers/v1/manifest/upsert_by_template',
      buildManifestTemplateCreatePayload(resolved.name, resolved.description, resolved.avatarUrl, randomUUID()),
    );
    const templateAppId = pickPayloadString(created, ['ClientID', 'clientID', 'clientId', 'appId']);
    if (!templateAppId?.startsWith('cli_')) {
      throw new Error('一键智能体模板创建返回成功但没有 ClientID（结果未知）；请到开放平台确认是否已创建同名应用后重试');
    }
    appId = templateAppId;
  } catch (err) {
    if (!isDefiniteTemplateRejection(err)) throw err;
    await options.onStatus?.(`一键模板创建被拒，回退普通自建应用: ${safeErrorMessage(err)}`);
    usedTemplate = false;
  }
  if (!appId) {
    const created = await client.postJson('/developers/v1/app/create', buildPlainAppCreatePayload(resolved.name, resolved.description, resolved.avatarUrl));
    appId = pickPayloadString(created, ['ClientID', 'clientID', 'clientId', 'appId']);
  }
  if (!appId?.startsWith('cli_')) throw new Error('开放平台创建应用后没有返回 ClientID');

  try {
    await client.postJsonIdempotent(`/developers/v1/robot/switch/${appId}`, { clientId: appId, enable: true });
    await client.postJsonIdempotent(`/developers/v1/event/switch/${appId}`, { clientId: appId, eventMode: LONG_CONNECTION_EVENT_MODE });
    let privilegeRangeWarning: string | undefined;
    try {
      await narrowRequiredPrivilegeRanges(client.postJson, appId);
    } catch (err) {
      privilegeRangeWarning = `权限数据范围自动收窄失败（不影响建 bot，可到开放平台手动选「与应用的可用范围一致」）: ${safeErrorMessage(err)}`;
    }
    // version/create + publish/commit are NOT idempotent: never retried.
    const versionCreated = await client.postJson(
      `/developers/v1/app_version/create/${appId}`,
      buildAppVersionCreatePayload('1.0.0', [options.creatorUserId]),
    );
    const versionId = extractVersionId(versionCreated);
    if (!versionId) throw new Error('上架启用版本创建返回成功但没有 versionId（可能已留下未发布草稿）；请到开放平台确认');
    await client.postJson(`/developers/v1/publish/commit/${appId}/${versionId}`, { clientId: appId });
    const appSecret = await fetchOpenPlatformAppSecret(client, appId, { idempotentRetry: true });
    return { appId, appSecret, identity: resolved, usedTemplate, privilegeRangeWarning };
  } catch (err) {
    throw new CreatedOpenPlatformAppError(appId, err);
  }
}

// ─── list / read secret (shared with the existing-app flow) ───────────────

export interface OpenPlatformAppSummary {
  clientId: string;
  name: string;
  description?: string;
}

async function listOpenPlatformAppsInternal(
  client: OpenPlatformApiClient,
  opts: { pageSize?: number; maxApps?: number } = {},
): Promise<OpenPlatformAppSummary[]> {
  const pageSize = opts.pageSize ?? 100;
  const maxApps = opts.maxApps ?? 500;
  const out: OpenPlatformAppSummary[] = [];
  for (let cursor = 0; cursor < maxApps; cursor += pageSize) {
    const payload = await client.postJson('/developers/v1/app/list', { Count: pageSize, Cursor: cursor, QueryFilter: {} });
    const record = asRecord(payload);
    const data = asRecord(record.data);
    const apps = Array.isArray(data.apps) ? data.apps : Array.isArray(record.apps) ? (record.apps as unknown[]) : [];
    for (const item of apps) {
      const rec = asRecord(item);
      const clientId = pickString(rec, ['clientId', 'client_id', 'appId', 'app_id', 'appID']);
      if (!clientId || !clientId.startsWith('cli_')) continue;
      const name = pickString(rec, ['name', 'appName', 'app_name']) ?? clientId;
      const description = pickString(rec, ['description', 'desc', 'appDesc', 'app_desc']);
      out.push({ clientId, name, ...(description ? { description } : {}) });
    }
    const totalCount = typeof data.totalCount === 'number' ? data.totalCount
      : typeof record.totalCount === 'number' ? (record.totalCount as number) : undefined;
    if (apps.length < pageSize) break;
    if (totalCount !== undefined && cursor + pageSize >= totalCount) break;
  }
  return out;
}

/** Self-built apps visible to the signed-in account (console `getAppList`, paginated). */
export const listOpenPlatformApps = listOpenPlatformAppsInternal;

/**
 * Read an app's AppSecret (console `getAppSecret`, read-only). Never touches
 * `/secret/reset/*` — that would rotate the secret and break running bots.
 */
export async function fetchOpenPlatformAppSecret(
  client: OpenPlatformApiClient,
  clientId: string,
  opts: { idempotentRetry?: boolean } = {},
): Promise<string> {
  const path = `/developers/v1/secret/${clientId}`;
  const payload = opts.idempotentRetry ? await client.postJsonIdempotent(path, {}) : await client.postJson(path, {});
  const record = asRecord(payload);
  const secret = pickString(asRecord(record.data), ['secret']) ?? pickString(record, ['secret']);
  if (!secret) throw new Error('开放平台没有返回 secret 字段');
  return secret;
}

// ─── one-call wrapper: session → client → create ──────────────────────────

export type CreateFeishuAppResult =
  | {
      ok: true;
      appId: string;
      appSecret: string;
      brand: 'feishu';
      sessionFile: string;
      sessionSource: WebSessionSource;
      sessionIdentity: WebSessionIdentity;
      identity: ResolvedIdentity;
      warnings: string[];
    }
  | {
      ok: false;
      reason: WebSessionFailureReason | 'missing_csrf' | 'identity_unavailable' | 'session_changed' | 'invalid_identity' | 'api_error';
      message: string;
      /** Set when the app WAS created: do not create another one; recover its secret instead. */
      appId?: string;
      sessionFile?: string;
    };

export interface CreateFeishuAppOptions extends WebSessionOptions {
  identity?: AppIdentity;
  /** Refuse to create when the cached session belongs to another user/tenant. */
  expectedIdentity?: Pick<WebSessionIdentity, 'userId' | 'tenantId'>;
  onSessionReady?: (info: { source: WebSessionSource; identity: WebSessionIdentity }) => void | Promise<void>;
}

export async function createFeishuOpenPlatformApp(options: CreateFeishuAppOptions = {}): Promise<CreateFeishuAppResult> {
  const prepared = await prepareWebSession(options);
  if (!prepared.ok) {
    return { ok: false, reason: prepared.reason, message: `获取飞书 Web session 失败: ${prepared.message}`, sessionFile: prepared.sessionFile };
  }
  const clientResult = await createOpenPlatformApiClient(prepared.cookies, { fetchImpl: options.fetchImpl });
  if (!clientResult.ok) {
    return { ok: false, reason: clientResult.reason, message: clientResult.message, sessionFile: prepared.sessionFile };
  }
  const sessionIdentity = clientResult.identity;
  if (!sessionIdentity) {
    return {
      ok: false,
      reason: 'identity_unavailable',
      message: '开放平台没有返回当前账号与企业信息；为避免创建到错误租户，未创建应用',
      sessionFile: prepared.sessionFile,
    };
  }
  if (options.expectedIdentity
    && (sessionIdentity.userId !== options.expectedIdentity.userId || sessionIdentity.tenantId !== options.expectedIdentity.tenantId)) {
    return {
      ok: false,
      reason: 'session_changed',
      message: `当前登录账号或企业已变化（${sessionIdentity.userName} · ${sessionIdentity.tenantName}）；请重新确认后再创建`,
      sessionFile: prepared.sessionFile,
    };
  }
  try {
    await options.onSessionReady?.({ source: prepared.source, identity: sessionIdentity });
    const created = await createOpenPlatformAppWithClient(clientResult.client, {
      identity: options.identity,
      creatorUserId: sessionIdentity.userId,
      creatorName: sessionIdentity.userName,
      fetchImpl: options.fetchImpl,
      onStatus: options.onStatus,
    });
    return {
      ok: true,
      appId: created.appId,
      appSecret: created.appSecret,
      brand: 'feishu',
      sessionFile: prepared.sessionFile,
      sessionSource: prepared.source,
      sessionIdentity,
      identity: created.identity,
      warnings: created.privilegeRangeWarning ? [created.privilegeRangeWarning] : [],
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof IdentityError ? 'invalid_identity' : 'api_error',
      message: safeErrorMessage(err),
      ...(err instanceof CreatedOpenPlatformAppError ? { appId: err.appId } : {}),
      sessionFile: prepared.sessionFile,
    };
  }
}
