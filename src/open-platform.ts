/**
 * 开放平台自动配置（复用飞书 Web session 调 console 内部接口 `/developers/v1/*`）：
 * 导入权限（scope）、订阅事件、配置重定向 URL、创建并提交发布版本。
 *
 * 仅支持飞书（feishu.cn）租户——Lark 国际版 console 机制不同。
 * 权限注册是非致命步骤：个别租户对部分权限有目录限制导致整批被拒时，
 * 只记 warning 并继续完成 redirect / 版本发布，不阻塞建 bot。
 */
import {
  MutableCookieJar,
  type StoredCookie,
  type WebSessionFailureReason,
  type WebSessionSource,
  asRecord,
  defaultSessionFilePath,
  pickString,
  prepareWebSession,
  safeErrorMessage,
  uniqueStrings,
  type WebSessionOptions,
} from './web-session.js';
import { DEFAULT_EVENTS, DEFAULT_SCOPE_MANIFEST, type ScopeManifest } from './presets.js';

export interface OpenPlatformScopeEntry {
  id: string;
  name: string;
  bucket?: 'tenant' | 'user';
}

export interface MappedScopeIds {
  tenantScopeIds: string[];
  userScopeIds: string[];
  missingTenantScopes: string[];
  missingUserScopes: string[];
}

export type ConfigureAppResult =
  | {
      ok: true;
      sessionFile: string;
      sessionSource: WebSessionSource;
      cookieCount: number;
      scopeCount: number;
      skippedScopeCount: number;
      scopeWarning?: string;
      subscribedEventCount: number;
      eventWarning?: string;
      versionId?: string;
    }
  | {
      ok: false;
      reason:
        | 'unsupported_brand'
        | WebSessionFailureReason
        | 'missing_csrf'
        | 'network'
        | 'api_error';
      message: string;
      sessionFile?: string;
      subscribedEventCount?: number;
      eventWarning?: string;
    };

export interface ConfigureAppOptions extends WebSessionOptions {
  appId: string;
  brand?: 'feishu' | 'lark';
  /** 权限清单，默认 {@link DEFAULT_SCOPE_MANIFEST}（含完整 VC 权限）。 */
  scopeManifest?: ScopeManifest;
  /** 订阅事件全量列表，默认 {@link DEFAULT_EVENTS}（消息基线 + VC 事件）。 */
  events?: string[];
  /** OAuth 重定向 URL；为空数组/未传时跳过安全设置步骤。 */
  redirectUrls?: string[];
  /** 是否创建并提交发布版本，默认 true。 */
  publishVersion?: boolean;
  /** 版本描述信息。 */
  versionRemark?: string;
}

export function buildScopeUpdatePayload(appId: string, mapped: Pick<MappedScopeIds, 'tenantScopeIds' | 'userScopeIds'>) {
  return {
    clientId: appId,
    appScopeIDs: mapped.tenantScopeIds,
    userScopeIDs: mapped.userScopeIds,
    scopeIds: [],
    operation: 'add',
    isDeveloperPanel: true,
  };
}

export function buildSafeSettingPayload(appId: string, redirectUrls: string[]) {
  return {
    clientId: appId,
    redirectURL: redirectUrls,
  };
}

export function buildEventSubscriptionPayload(appId: string, events: string[]) {
  return {
    clientId: appId,
    eventNames: events,
    isDeveloperPanel: true,
  };
}

export function buildAppVersionCreatePayload(
  appVersion: string,
  visibleMemberIds: string[] = [],
  remark = 'Bot app created by create-lark-bot',
) {
  return {
    appVersion,
    mobileDefaultAbility: 'bot',
    pcDefaultAbility: 'bot',
    changeLog: 'Init version',
    visibleSuggest: {
      departments: [],
      members: visibleMemberIds,
      groups: [],
      isAll: 0,
    },
    applyReasonConfig: {
      apiPrivilegeNeedReason: true,
      contactPrivilegeNeedReason: true,
      dataPrivilegeReasonMap: {},
      visibleScopeNeedReason: true,
      apiPrivilegeReasonMap: {},
      contactPrivilegeReason: '',
      isDataPrivilegeExpandMap: {},
      visibleScopeReason: '',
      dataPrivilegeNeedReason: true,
      isAutoAudit: false,
      isContactExpand: false,
    },
    b2cShareSuggest: false,
    autoPublish: false,
    remark,
    blackVisibleSuggest: {
      departments: [],
      members: [],
      groups: [],
      isAll: 0,
    },
  };
}

export function extractOpenPlatformCsrfToken(html: string): string | null {
  const match =
    html.match(/\bwindow\.csrfToken\s*=\s*(['"])([^'"]+)\1/) ??
    html.match(/\bcsrfToken\s*:\s*(['"])([^'"]+)\1/);
  return match?.[2] ?? null;
}

export function extractOpenPlatformScopeEntries(payload: unknown): OpenPlatformScopeEntry[] {
  const out: OpenPlatformScopeEntry[] = [];
  collectScopeEntries(payload, undefined, out);
  const seen = new Set<string>();
  return out.filter(entry => {
    const key = `${entry.bucket ?? 'any'}:${entry.name}:${entry.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function mapManifestScopesToOpenPlatformIds(
  manifest: ScopeManifest,
  catalog: OpenPlatformScopeEntry[],
): MappedScopeIds {
  const tenant = uniqueStrings(manifest.scopes?.tenant ?? []);
  const user = uniqueStrings(manifest.scopes?.user ?? []);
  return {
    tenantScopeIds: mapScopeIds(tenant, catalog, 'tenant').ids,
    userScopeIds: mapScopeIds(user, catalog, 'user').ids,
    missingTenantScopes: mapScopeIds(tenant, catalog, 'tenant').missing,
    missingUserScopes: mapScopeIds(user, catalog, 'user').missing,
  };
}

/**
 * 主入口：准备 Web session（缓存 / 扫码）→ 提取 console CSRF → 依次执行
 * 权限导入、事件订阅、安全设置、版本创建 + 发布提交。
 */
export async function configureOpenPlatformApp(options: ConfigureAppOptions): Promise<ConfigureAppResult> {
  const brand = options.brand ?? 'feishu';
  if (brand !== 'feishu') {
    return { ok: false, reason: 'unsupported_brand', message: '开放平台自动配置当前只支持 feishu.cn 租户' };
  }

  const fetcher = options.fetchImpl ?? fetch;
  const preparedSession = await prepareWebSession({
    sessionFilePath: options.sessionFilePath ?? defaultSessionFilePath(),
    fallbackSessionFiles: options.fallbackSessionFiles,
    fetchImpl: fetcher,
    pollIntervalMs: options.pollIntervalMs,
    maxWaitMs: options.maxWaitMs,
    onQrCode: options.onQrCode,
    onStatus: options.onStatus,
  });
  if (!preparedSession.ok) {
    return {
      ok: false,
      reason: preparedSession.reason,
      message: `获取 Feishu Web session 失败: ${preparedSession.message}`,
      sessionFile: preparedSession.sessionFile,
    };
  }

  const sessionFile = preparedSession.sessionFile;
  const session = new MutableCookieJar(preparedSession.cookies);
  const defaultOrigin = 'https://open.feishu.cn';
  const defaultAppHome = `${defaultOrigin}/app/${options.appId}`;
  // Web 登录得到的是可复用 cookie，不含 console 页面级 `window.csrfToken`。
  // 带 cookie 加载一次开放平台页面提取 CSRF；部分租户会把 console 重定向到
  // open.larkoffice.com，API origin / referer / CSRF / cookie 必须停留在最终 origin。
  let csrfToken: string | null = null;
  let apiOrigin = defaultOrigin;
  let appHome = defaultAppHome;
  try {
    const authPage = await session.fetchTextWithUrl(fetcher, `${defaultAppHome}/auth`);
    apiOrigin = new URL(authPage.finalUrl).origin;
    appHome = `${apiOrigin}/app/${options.appId}`;
    csrfToken = extractOpenPlatformCsrfToken(authPage.text);
    if (!csrfToken) {
      const homePage = await session.fetchTextWithUrl(fetcher, appHome);
      apiOrigin = new URL(homePage.finalUrl).origin;
      appHome = `${apiOrigin}/app/${options.appId}`;
      csrfToken = extractOpenPlatformCsrfToken(homePage.text);
    }
  } catch (err) {
    return { ok: false, reason: 'network', message: `读取开放平台页面失败: ${safeErrorMessage(err)}`, sessionFile };
  }
  if (!csrfToken) {
    return {
      ok: false,
      reason: 'missing_csrf',
      message: 'Feishu session 可读取，但开放平台页面没有返回 window.csrfToken；可能需要在浏览器完成开放平台登录',
      sessionFile,
    };
  }

  const postJson = createPostJson(session, fetcher, apiOrigin, appHome, csrfToken);

  let allScopesPayload: unknown;
  try {
    allScopesPayload = await postJson(`/developers/v1/scope/all/${options.appId}`);
  } catch (err) {
    return { ok: false, reason: 'api_error', message: `读取开放平台 scope 列表失败: ${safeErrorMessage(err)}`, sessionFile };
  }

  const manifest = options.scopeManifest ?? DEFAULT_SCOPE_MANIFEST;
  const catalog = extractOpenPlatformScopeEntries(allScopesPayload);
  const mapped = mapManifestScopesToOpenPlatformIds(manifest, catalog);
  const missing = [...mapped.missingTenantScopes, ...mapped.missingUserScopes];
  const skippedScopeCount = missing.length;

  let importedScopeCount = mapped.tenantScopeIds.length + mapped.userScopeIds.length;
  let scopeWarning: string | undefined;
  if (importedScopeCount > 0) {
    try {
      await postJson(`/developers/v1/scope/update/${options.appId}`, buildScopeUpdatePayload(options.appId, mapped));
    } catch (err) {
      scopeWarning = safeErrorMessage(err);
      importedScopeCount = 0;
    }
  }

  // 事件订阅（替换式接口，必须提交全量）。console 前端端点随租户/版本略有差异，
  // 逐个尝试已知形态；全部失败仅记 warning，用户可去后台手动订阅。
  const allEvents = options.events ?? DEFAULT_EVENTS;
  let subscribedEventCount = 0;
  let eventWarning: string | undefined;
  const eventEndpoints = [
    {
      path: `/developers/v1/event/update/${options.appId}`,
      body: buildEventSubscriptionPayload(options.appId, allEvents),
    },
    {
      path: `/developers/v1/event/update/${options.appId}`,
      body: { clientId: options.appId, eventNameList: allEvents, isDeveloperPanel: true },
    },
    {
      path: `/developers/v1/event_callback/update/${options.appId}`,
      body: { clientId: options.appId, eventNames: allEvents, isDeveloperPanel: true },
    },
  ];
  if (allEvents.length > 0) {
    for (const attempt of eventEndpoints) {
      try {
        await postJson(attempt.path, attempt.body);
        subscribedEventCount = allEvents.length;
        eventWarning = undefined;
        break;
      } catch (err) {
        eventWarning = safeErrorMessage(err);
      }
    }
  }

  try {
    const redirectUrls = options.redirectUrls ?? [];
    if (redirectUrls.length > 0) {
      await postJson(`/developers/v1/safe_setting/update/${options.appId}`, buildSafeSettingPayload(options.appId, redirectUrls));
    }
    let versionId: string | undefined;
    if (options.publishVersion !== false) {
      const contactRange = await postJson(`/developers/v1/contact_range/${options.appId}`, {});
      const visibleMemberIds = extractContactRangeMemberIds(contactRange);
      const versionList = await postJson(`/developers/v1/app_version/list/${options.appId}`, {});
      const appVersion = nextAppVersion(versionList);
      const created = await postJson(
        `/developers/v1/app_version/create/${options.appId}`,
        buildAppVersionCreatePayload(appVersion, visibleMemberIds, options.versionRemark),
      );
      versionId = extractVersionId(created);
      if (versionId) {
        await postJson(`/developers/v1/publish/commit/${options.appId}/${versionId}`, { clientId: options.appId });
      }
    }
    return {
      ok: true,
      sessionFile,
      sessionSource: preparedSession.source,
      cookieCount: preparedSession.cookieCount,
      scopeCount: importedScopeCount,
      skippedScopeCount,
      scopeWarning,
      subscribedEventCount,
      eventWarning,
      versionId,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'api_error',
      message: `开放平台自动配置失败: ${safeErrorMessage(err)}`,
      sessionFile,
      subscribedEventCount,
      eventWarning,
    };
  }
}

// ─── 已有应用列表 / 凭证读取 ────────────────────────────────────────────────

export interface OpenPlatformAppSummary {
  clientId: string;
  name: string;
  description?: string;
}

export interface OpenPlatformApiClient {
  apiOrigin: string;
  postJson(path: string, body?: unknown): Promise<unknown>;
}

export type OpenPlatformClientResult =
  | { ok: true; client: OpenPlatformApiClient }
  | { ok: false; reason: 'missing_csrf' | 'network'; message: string };

/**
 * 用已就绪的 Web session cookies 构造开放平台 console API 客户端：加载 console
 * 页面提取 `window.csrfToken` 与最终 origin，返回可调 `/developers/v1/*` 的 postJson。
 */
export async function createOpenPlatformApiClient(
  cookies: StoredCookie[],
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<OpenPlatformClientResult> {
  const fetcher = opts.fetchImpl ?? fetch;
  const session = new MutableCookieJar(cookies);
  let csrfToken: string | null = null;
  let apiOrigin = 'https://open.feishu.cn';
  let referer = `${apiOrigin}/app`;
  try {
    const page = await session.fetchTextWithUrl(fetcher, `${apiOrigin}/app`);
    apiOrigin = new URL(page.finalUrl).origin;
    referer = page.finalUrl;
    csrfToken = extractOpenPlatformCsrfToken(page.text);
  } catch (err) {
    return { ok: false, reason: 'network', message: `读取开放平台页面失败: ${safeErrorMessage(err)}` };
  }
  if (!csrfToken) {
    return {
      ok: false,
      reason: 'missing_csrf',
      message: '开放平台页面没有返回 window.csrfToken；Web session 可能已过期或未完成开放平台登录',
    };
  }
  const postJson = createPostJson(session, fetcher, apiOrigin, referer, csrfToken);
  return { ok: true, client: { apiOrigin, postJson } };
}

/** 列出当前登录人可见的自建应用（console `getAppList` 同款接口，分页拉全）。 */
export async function listOpenPlatformApps(
  client: OpenPlatformApiClient,
  opts: { pageSize?: number; maxApps?: number } = {},
): Promise<OpenPlatformAppSummary[]> {
  const pageSize = opts.pageSize ?? 100;
  const maxApps = opts.maxApps ?? 500;
  const out: OpenPlatformAppSummary[] = [];
  for (let cursor = 0; cursor < maxApps; cursor += pageSize) {
    const payload = await client.postJson('/developers/v1/app/list', {
      Count: pageSize,
      Cursor: cursor,
      QueryFilter: {},
    });
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

/**
 * 读取指定应用的 App Secret（console `getAppSecret` 同款只读接口）。
 * 绝不触碰 /v1/secret/reset/*（会轮换 secret、打断在跑的应用）。
 */
export async function fetchOpenPlatformAppSecret(
  client: OpenPlatformApiClient,
  clientId: string,
): Promise<string> {
  const payload = await client.postJson(`/developers/v1/secret/${clientId}`, {});
  const record = asRecord(payload);
  const secret = pickString(asRecord(record.data), ['secret']) ?? pickString(record, ['secret']);
  if (!secret) throw new Error('开放平台没有返回 secret 字段');
  return secret;
}

export class OpenPlatformApiError extends Error {
  constructor(message: string, readonly payload: unknown) {
    super(message);
  }
}

function createPostJson(
  session: MutableCookieJar,
  fetcher: typeof fetch,
  apiOrigin: string,
  referer: string,
  csrfToken: string,
): (path: string, body?: unknown) => Promise<unknown> {
  return async (path, body) => {
    const url = `${apiOrigin}${path}`;
    const response = await session.fetchRaw(fetcher, url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: apiOrigin,
        referer,
        'x-csrf-token': csrfToken,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data: any;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      throw new OpenPlatformApiError(`HTTP ${response.status} ${path}: ${summarizePayload(data)}`, data);
    }
    if (data && typeof data === 'object' && typeof data.code === 'number' && data.code !== 0) {
      throw new OpenPlatformApiError(`code=${data.code} msg=${data.msg ?? data.message ?? ''}`, data);
    }
    return data;
  };
}

function collectScopeEntries(value: unknown, bucket: 'tenant' | 'user' | undefined, out: OpenPlatformScopeEntry[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectScopeEntries(item, bucket, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const name = pickString(record, ['scope_name', 'scopeName', 'name', 'key', 'scopeKey']);
  const id = pickString(record, ['id', 'scope_id', 'scopeId', 'scopeID']);
  if (name && id) out.push({ name, id, bucket });
  for (const [key, child] of Object.entries(record)) {
    const nextBucket = /user/i.test(key)
      ? 'user'
      : /app|client|tenant/i.test(key)
        ? 'tenant'
        : bucket;
    if (child && typeof child === 'object') collectScopeEntries(child, nextBucket, out);
  }
}

function mapScopeIds(scopeNames: string[], catalog: OpenPlatformScopeEntry[], bucket: 'tenant' | 'user') {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const scopeName of scopeNames) {
    const matched =
      catalog.find(entry => entry.name === scopeName && entry.bucket === bucket) ??
      catalog.find(entry => entry.name === scopeName && entry.bucket === undefined) ??
      catalog.find(entry => entry.name === scopeName);
    if (matched) ids.push(matched.id);
    else missing.push(scopeName);
  }
  return { ids: uniqueStrings(ids), missing };
}

/** 从 app_version/list 响应算下一个版本号（最新已发布 +1，无发布版 → 0.0.1）。 */
export function nextAppVersion(payload: unknown): string {
  const data = asRecord(asRecord(payload).data);
  const versions = Array.isArray(data.versions) ? data.versions : [];
  const published = versions
    .map(item => asRecord(item))
    .filter(item => item.versionStatus === 2)
    .map(item => pickString(item, ['appVersion']))
    .filter((version): version is string => Boolean(version));
  if (published.length === 0) return '0.0.1';
  const latest = published[0];
  const parts = latest.split('.').map(part => Number.parseInt(part, 10));
  if (parts.length < 3 || parts.some(part => !Number.isFinite(part))) return '0.0.1';
  parts[parts.length - 1] += 1;
  return parts.join('.');
}

function extractContactRangeMemberIds(payload: unknown): string[] {
  const data = asRecord(asRecord(payload).data);
  const detail = asRecord(data.contactRangeDetail);
  const members = Array.isArray(detail.members) ? detail.members : [];
  return uniqueStrings(members
    .map(item => pickString(asRecord(item), ['id']))
    .filter((id): id is string => Boolean(id)));
}

/** 从 app_version/create 响应提取 versionId（多种响应形态兼容）。 */
export function extractVersionId(payload: unknown): string | undefined {
  const direct = pickString(asRecord(payload), ['versionId', 'version_id', 'id']);
  if (direct) return direct;
  const data = asRecord(asRecord(payload).data);
  return pickString(data, ['versionId', 'version_id', 'id']) ?? pickString(asRecord(data.appVersion), ['versionId', 'version_id', 'id']);
}

function summarizePayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return String(payload);
  const record = payload as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ['code', 'msg', 'message', 'error', 'error_msg']) {
    if (record[key] !== undefined) summary[key] = record[key];
  }
  return JSON.stringify(summary).slice(0, 500);
}
