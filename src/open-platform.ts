/**
 * Configure a Feishu app through the Open Platform console (reusing the Web session):
 * redirect whitelist → scopes → privilege data ranges → bot capability + long connection →
 * events (+ user events) → callbacks → (if anything changed / app just created) version
 * create + publish with visibility mirrored from the online version, approval prediction,
 * draft reuse and commit read-back.
 *
 * Feishu (feishu.cn) only — the Lark international console differs; use the SDK flow there.
 *
 * Ported from botmux (https://github.com/deepcoldy/botmux, MIT)
 * src/setup/open-platform-automation.ts `automateOpenPlatformSetup`, including:
 *  - 9f8a389a  events/callbacks via the console's incremental `operation:'add'` contract + read-back, fail closed on the critical ones
 *  - 56da97f1  publishing mirrors visible/online (never resets visibility)
 *  - a9523e10 / e861d92e / 39ecc8de / 1630fc22  skip publishing when nothing changed; granted-scope diff per bucket
 *  - 51fc53f1 / 973b6c98  privilege data range → "same as app availability"; draft reuse; commit read-back; approval prediction
 *  - df5f4ecf / 80474f41  redirect whitelist read-merge-write, never deletes user entries
 *  - 34676511 et al.  under-review (code=10046) as its own non-retry reason; session-expiry detection
 */
import {
  createOpenPlatformApiClient,
  openPlatformOwnerAccessDenied,
  openPlatformUnderReview,
  openPlatformWebSessionExpired,
  type OpenPlatformApiClient,
} from './console-client.js';
import {
  buildAppVersionCreatePayload,
  buildCallbackSubscriptionPayload,
  buildEventSubscriptionPayload,
  buildScopeUpdatePayload,
  extractOpenPlatformCallbackState,
  extractOpenPlatformEventState,
  extractOpenPlatformScopeEntries,
  extractVersionId,
  fetchApprovalFlowPrediction,
  findInReviewVersionId,
  findUncommittedDraftVersionId,
  isVersionCommitted,
  LONG_CONNECTION_EVENT_MODE,
  mapManifestScopesToOpenPlatformIds,
  missingRedirectUrls,
  narrowRequiredPrivilegeRanges,
  nextAppVersion,
  writeRedirectWhitelist,
  type OpenPlatformCallbackState,
  type OpenPlatformEventState,
} from './console-ops.js';
import {
  AUTO_REJECTED_SCOPES,
  BOT_OPTIONAL_EVENTS,
  classifyEventNames,
  composePresets,
  DEFAULT_MANIFEST,
  type BotPreset,
  type PresetName,
  type ScopeManifest,
} from './presets.js';
import { safeErrorMessage, uniqueStrings } from './util.js';
import { mergeVisibility, parseOnlineVisibility, VisibilityParseError, type VisibilityAdditions, type VisibilitySuggest } from './visibility.js';
import {
  defaultSessionFilePath,
  prepareWebSession,
  type WebSessionFailureReason,
  type WebSessionOptions,
  type WebSessionSource,
} from './web-session.js';

export type ConfigureFailureReason =
  | 'unsupported_brand'
  | WebSessionFailureReason
  | 'missing_csrf'
  /** The console logged this session out: re-scan (forceQrLogin) and retry. */
  | 'session_expired'
  /** The signed-in account is not a collaborator of this app. */
  | 'owner_session_mismatch'
  | 'event_verification_failed'
  | 'visibility_unreadable'
  /** A version is under review (code=10046): writes are locked until it is approved/withdrawn. Do not loop. */
  | 'app_under_review'
  | 'network'
  | 'api_error';

export type ConfigureAppResult =
  | {
      ok: true;
      sessionFile: string;
      sessionSource: WebSessionSource | 'client';
      cookieCount: number;
      scopeCount: number;
      skippedScopeCount: number;
      /** Requested scopes removed because Feishu auto-rejects publishing with them. */
      droppedScopes: string[];
      scopeWarning?: string;
      privilegeRangeCount: number;
      privilegeRangeWarning?: string;
      subscribedEventCount: number;
      eventWarning?: string;
      /** Requested events still missing after read-back (non-critical ones only; critical → ok:false). */
      missingEvents: string[];
      missingCallbacks: string[];
      eventModeReady: boolean;
      /** Every requested redirect URL is live (vacuously true when none requested). */
      redirectConfigured: boolean;
      redirectWarning?: string;
      versionId?: string;
      /** Nothing changed, so no version was created (not a warning). */
      publishSkipped?: boolean;
      /** An existing uncommitted draft was committed instead of creating a new version. */
      versionReused?: boolean;
      /** Commit returned success but read-back still shows a draft (or read-back failed). */
      versionWarning?: string;
      /** undefined = could not be predicted. */
      approvalAutoPassed?: boolean;
      approvalHumanApprovers?: string[];
    }
  | {
      ok: false;
      reason: ConfigureFailureReason;
      message: string;
      sessionFile?: string;
      subscribedEventCount?: number;
      eventWarning?: string;
      missingEvents?: string[];
      eventModeReady?: boolean;
      redirectConfigured?: boolean;
      redirectWarning?: string;
      /** app_under_review: the version waiting for approval, when readable. */
      inReviewVersionId?: string;
    };

export interface ConfigureAppOptions extends WebSessionOptions {
  appId: string;
  brand?: 'feishu' | 'lark';
  /** Compose scopes/events/callbacks from presets. Default: {@link DEFAULT_MANIFEST}. */
  presets?: Array<PresetName | BotPreset>;
  /** Scope manifest; overrides the scope part of `presets`. */
  scopeManifest?: ScopeManifest;
  /**
   * Events (flat list, 0.1.x compatible). User-identity events and callbacks found in the
   * list are routed to the right bucket. Overrides the event part of `presets`.
   * The console contract is additive: events already subscribed are never removed.
   */
  events?: string[];
  /** Extra user-identity events. */
  userEvents?: string[];
  /** Callbacks; overrides the callback part of `presets`. */
  callbacks?: string[];
  /**
   * Events/callbacks whose absence after read-back fails the run.
   * Default: `im.message.receive_v1` and `card.action.trigger` when requested.
   */
  criticalEvents?: string[];
  /** OAuth redirect URLs to ensure in the whitelist (merged; existing entries are kept). */
  redirectUrls?: string[];
  /** Additive visibility change applied to the published version (never narrows). */
  visibility?: VisibilityAdditions;
  /** Create + publish a version (only when something changed or the app was just created). Default true. */
  publishVersion?: boolean;
  /** Version change log. */
  versionRemark?: string;
  /** Already-granted scope names per bucket: only the difference is requested. */
  grantedScopeNames?: { tenant: string[]; user: string[] };
  /**
   * The app was created in this very run: always publish, and allow writing the redirect
   * whitelist even if the (necessarily empty) live list cannot be read.
   */
  appJustCreated?: boolean;
  /** Reuse an existing console client (same session) instead of preparing one. */
  client?: OpenPlatformApiClient;
}

/** Effective manifest for a configure/create run. */
export function resolveRequestedManifest(options: Pick<ConfigureAppOptions, 'presets' | 'scopeManifest' | 'events' | 'userEvents' | 'callbacks'>) {
  const base = options.presets ? composePresets(...options.presets) : DEFAULT_MANIFEST;
  const classified = options.events ? classifyEventNames(options.events) : undefined;
  const tenant = options.scopeManifest ? uniqueStrings(options.scopeManifest.scopes?.tenant ?? []) : base.scopes.tenant;
  const user = options.scopeManifest ? uniqueStrings(options.scopeManifest.scopes?.user ?? []) : base.scopes.user;
  const rejected = new Set<string>(AUTO_REJECTED_SCOPES);
  const droppedScopes = uniqueStrings([...tenant, ...user].filter(name => rejected.has(name)));
  return {
    scopes: { tenant: tenant.filter(n => !rejected.has(n)), user: user.filter(n => !rejected.has(n)) },
    events: {
      app: classified ? classified.app : base.events.app,
      user: uniqueStrings([...(classified ? classified.user : base.events.user), ...(options.userEvents ?? [])]),
    },
    callbacks: options.callbacks
      ? uniqueStrings(options.callbacks)
      : uniqueStrings([...(classified && classified.callbacks.length ? classified.callbacks : base.callbacks)]),
    droppedScopes,
  };
}

export async function configureOpenPlatformApp(options: ConfigureAppOptions): Promise<ConfigureAppResult> {
  const brand = options.brand ?? 'feishu';
  if (brand !== 'feishu') {
    return { ok: false, reason: 'unsupported_brand', message: '开放平台自动配置当前只支持 feishu.cn 租户；Lark 请用 SDK 流程（addons）或到开放平台手动配置' };
  }
  const appId = options.appId;
  const requested = resolveRequestedManifest(options);

  let client = options.client;
  let sessionFile = options.sessionFilePath ?? defaultSessionFilePath();
  let sessionSource: WebSessionSource | 'client' = 'client';
  let cookieCount = 0;
  if (!client) {
    const prepared = await prepareWebSession({ ...options, sessionFilePath: sessionFile });
    if (!prepared.ok) {
      return { ok: false, reason: prepared.reason, message: `获取飞书 Web session 失败: ${prepared.message}`, sessionFile: prepared.sessionFile };
    }
    sessionFile = prepared.sessionFile;
    sessionSource = prepared.source;
    cookieCount = prepared.cookieCount;
    const created = await createOpenPlatformApiClient(prepared.cookies, { fetchImpl: options.fetchImpl, appId });
    if (!created.ok) {
      return {
        ok: false,
        reason: created.reason,
        message: created.reason === 'missing_csrf'
          ? '飞书 session 可读取，但开放平台页面没有返回 window.csrfToken；需要重新扫码登录'
          : created.message,
        sessionFile,
      };
    }
    client = created.client;
  }
  const postJson = client.postJson;
  const status = async (message: string) => { await options.onStatus?.(message); };

  /** Shared classification for a fatal write/read failure. */
  const fail = (err: unknown, fallback: string, extra: Partial<Extract<ConfigureAppResult, { ok: false }>> = {}): ConfigureAppResult => {
    if (openPlatformWebSessionExpired(err)) {
      return { ok: false, reason: 'session_expired', message: '飞书开放平台登录态已失效，请重新扫码后重试', sessionFile, ...extra };
    }
    if (openPlatformOwnerAccessDenied(err)) {
      return { ok: false, reason: 'owner_session_mismatch', message: `当前登录账号不是应用 ${appId} 的协作者（code=10003）`, sessionFile, ...extra };
    }
    return { ok: false, reason: 'api_error', message: `${fallback}: ${safeErrorMessage(err)}`, sessionFile, ...extra };
  };

  // 1) redirect whitelist — first, and independently: its absence is a hard OAuth failure (20029)
  //    while every later step may bail out.
  let mutated = false;
  let redirectConfigured = true;
  let redirectWarning: string | undefined;
  const wantedRedirects = uniqueStrings(options.redirectUrls ?? []);
  if (wantedRedirects.length > 0) {
    redirectConfigured = false;
    try {
      const written = await writeRedirectWhitelist(postJson, appId, wantedRedirects, { allowBlindWrite: options.appJustCreated === true });
      if (written.status === 'updated' || written.status === 'updated_fallback') mutated = true;
      if (written.status === 'skipped_unreadable') {
        redirectWarning = written.warning;
      } else {
        const missing = missingRedirectUrls(wantedRedirects, written.redirectUrls);
        if (missing.length === 0) redirectConfigured = true;
        else redirectWarning = `以下回调地址未生效: ${missing.join('、')}`;
      }
    } catch (err) {
      if (openPlatformWebSessionExpired(err)) return fail(err, '');
      redirectWarning = `写入 redirect 白名单失败: ${safeErrorMessage(err)}`;
    }
  }

  // 2) scopes (non-fatal: some tenants refuse a whole batch for one ungrantable scope)
  let allScopesPayload: unknown;
  try {
    allScopesPayload = await postJson(`/developers/v1/scope/all/${appId}`);
  } catch (err) {
    return fail(err, '读取开放平台 scope 列表失败', { redirectConfigured, redirectWarning });
  }
  const grantedTenant = options.grantedScopeNames ? new Set(options.grantedScopeNames.tenant) : undefined;
  const grantedUser = options.grantedScopeNames ? new Set(options.grantedScopeNames.user) : undefined;
  const effectiveManifest: ScopeManifest = {
    scopes: {
      tenant: requested.scopes.tenant.filter(name => !grantedTenant?.has(name)),
      user: requested.scopes.user.filter(name => !grantedUser?.has(name)),
    },
  };
  const mapped = mapManifestScopesToOpenPlatformIds(effectiveManifest, extractOpenPlatformScopeEntries(allScopesPayload));
  const skipped = [...mapped.missingTenantScopes, ...mapped.missingUserScopes];
  if (skipped.length > 0) await status(`${skipped.length} 项权限不在当前租户的权限目录中，已跳过: ${skipped.slice(0, 8).join(', ')}`);
  if (requested.droppedScopes.length > 0) {
    await status(`已移除会导致发版被自动驳回的权限: ${requested.droppedScopes.join(', ')}`);
  }
  let scopeCount = mapped.tenantScopeIds.length + mapped.userScopeIds.length;
  let scopeWarning: string | undefined;
  if (scopeCount > 0) {
    try {
      await postJson(`/developers/v1/scope/update/${appId}`, buildScopeUpdatePayload(appId, mapped));
      mutated = true;
    } catch (err) {
      if (openPlatformWebSessionExpired(err)) return fail(err, '');
      scopeWarning = safeErrorMessage(err);
      scopeCount = 0;
    }
  }

  // 3) privilege data ranges (non-fatal)
  let privilegeRangeCount = 0;
  let privilegeRangeWarning: string | undefined;
  try {
    privilegeRangeCount = await narrowRequiredPrivilegeRanges(postJson, appId);
    if (privilegeRangeCount > 0) mutated = true;
  } catch (err) {
    privilegeRangeWarning = safeErrorMessage(err);
  }

  // 4) bot capability + long connection: fatal, and the first write that does not swallow 10046.
  try {
    await client.postJsonIdempotent(`/developers/v1/robot/switch/${appId}`, { clientId: appId, enable: true });
    await client.postJsonIdempotent(`/developers/v1/event/switch/${appId}`, { clientId: appId, eventMode: LONG_CONNECTION_EVENT_MODE });
  } catch (err) {
    if (openPlatformUnderReview(err)) {
      let inReviewVersionId: string | undefined;
      try {
        inReviewVersionId = findInReviewVersionId(await postJson(`/developers/v1/app_version/list/${appId}`, {}));
      } catch { /* only a throttle key */ }
      return {
        ok: false,
        reason: 'app_under_review',
        message:
          '应用有版本正在飞书审核中，开放平台暂时锁定了配置写入（权限、机器人能力、回调白名单都改不了）。'
          + '审批被触发通常意味着有配置不合规（最常见：权限「数据范围」是「全部」）。请到开放平台查看审批详情、修正后再撤回重提；'
          + '直接撤回重提会被同一规则再次拦下。',
        sessionFile,
        redirectConfigured,
        redirectWarning,
        inReviewVersionId,
      };
    }
    return fail(err, '启用机器人能力或长连接事件模式失败', { redirectConfigured, redirectWarning });
  }

  // 5) events: read → add missing (by identity bucket) → read back
  const eventWarnings: string[] = [];
  const readEventState = async () =>
    extractOpenPlatformEventState(await postJson(`/developers/v1/event/${appId}`, { needEventDetail: true }));
  const addEvents = (appEvents: string[], userEvents: string[], eventMode: number) =>
    postJson(`/developers/v1/event/update/${appId}`, buildEventSubscriptionPayload(appId, eventMode, appEvents, userEvents));
  let eventState: OpenPlatformEventState | undefined;
  try {
    eventState = await readEventState();
  } catch (err) {
    if (openPlatformWebSessionExpired(err)) return fail(err, '');
    eventWarnings.push(`读取当前事件订阅失败: ${safeErrorMessage(err)}`);
  }
  const hasEvent = (name: string) => Boolean(eventState?.events.includes(name));
  const missingApp = requested.events.app.filter(name => !hasEvent(name));
  const missingUser = requested.events.user.filter(name => !hasEvent(name));
  if (missingApp.length > 0 || missingUser.length > 0) {
    mutated = true;
    const eventMode = eventState?.eventMode ?? LONG_CONNECTION_EVENT_MODE;
    try {
      await addEvents(missingApp, missingUser, eventMode);
    } catch {
      // one event whose scope is not grantable rejects the batch → add one by one
      for (const name of missingApp) {
        try {
          await addEvents([name], [], eventMode);
        } catch (err) {
          const optional = (BOT_OPTIONAL_EVENTS as readonly string[]).includes(name) ? '（可选事件）' : '';
          eventWarnings.push(`订阅事件 ${name} 失败${optional}: ${safeErrorMessage(err)}`);
        }
      }
      for (const name of missingUser) {
        try {
          await addEvents([], [name], eventMode);
        } catch (err) {
          eventWarnings.push(`订阅事件 ${name} 失败: ${safeErrorMessage(err)}`);
        }
      }
    }
    try {
      eventState = await readEventState();
    } catch (err) {
      eventWarnings.push(`回读事件订阅失败: ${safeErrorMessage(err)}`);
    }
  }
  const wantedEvents = [...requested.events.app, ...requested.events.user];
  const missingEvents = wantedEvents.filter(name => !hasEvent(name));
  if (missingEvents.length > 0) eventWarnings.push(`事件未确认订阅: ${missingEvents.join(', ')}`);

  // 6) callbacks (card.action.trigger lives under /callback/*, with its own receive mode)
  const readCallbackState = async () => extractOpenPlatformCallbackState(await postJson(`/developers/v1/callback/${appId}`, {}));
  let callbackState: OpenPlatformCallbackState | undefined;
  let missingCallbacks: string[] = [];
  if (requested.callbacks.length > 0) {
    try {
      callbackState = await readCallbackState();
    } catch (err) {
      eventWarnings.push(`读取当前回调订阅失败: ${safeErrorMessage(err)}`);
    }
    if (callbackState && callbackState.callbackMode !== LONG_CONNECTION_EVENT_MODE) {
      mutated = true;
      try {
        await postJson(`/developers/v1/callback/switch/${appId}`, { clientId: appId, callbackMode: LONG_CONNECTION_EVENT_MODE });
        callbackState = await readCallbackState();
      } catch (err) {
        eventWarnings.push(`切换回调长连接模式失败: ${safeErrorMessage(err)}`);
      }
    }
    missingCallbacks = requested.callbacks.filter(name => !callbackState?.callbacks.includes(name));
    if (missingCallbacks.length > 0) {
      mutated = true;
      try {
        await postJson(
          `/developers/v1/callback/update/${appId}`,
          buildCallbackSubscriptionPayload(appId, callbackState?.callbackMode ?? LONG_CONNECTION_EVENT_MODE, missingCallbacks),
        );
      } catch (err) {
        eventWarnings.push(`订阅回调失败: ${safeErrorMessage(err)}`);
      }
      try {
        callbackState = await readCallbackState();
      } catch (err) {
        eventWarnings.push(`回读回调订阅失败: ${safeErrorMessage(err)}`);
      }
      missingCallbacks = requested.callbacks.filter(name => !callbackState?.callbacks.includes(name));
    }
  }

  const subscribedEventCount = wantedEvents.filter(hasEvent).length
    + requested.callbacks.filter(name => callbackState?.callbacks.includes(name)).length;
  const eventWarning = eventWarnings.length > 0 ? eventWarnings.join('; ') : undefined;
  const eventModeReady = eventState?.eventMode === LONG_CONNECTION_EVENT_MODE;
  const critical = options.criticalEvents ?? ['im.message.receive_v1', 'card.action.trigger'];
  const criticalIssues = [
    ...critical.filter(name => wantedEvents.includes(name) && !hasEvent(name)),
    ...critical.filter(name => missingCallbacks.includes(name)),
  ];
  if (!eventModeReady) criticalIssues.push(`事件接收模式=${eventState?.eventMode ?? '未知'}（需长连接 ${LONG_CONNECTION_EVENT_MODE}）`);
  if (requested.callbacks.length > 0 && callbackState?.callbackMode !== LONG_CONNECTION_EVENT_MODE) {
    criticalIssues.push(`回调接收模式=${callbackState?.callbackMode ?? '未知'}（需长连接 ${LONG_CONNECTION_EVENT_MODE}）`);
  }
  if (criticalIssues.length > 0) {
    return {
      ok: false,
      reason: 'event_verification_failed',
      message: `核心事件/回调订阅未生效（${criticalIssues.join('; ')}），机器人将收不到消息或卡片点击；请到开放平台「事件与回调」手动补齐后重试`,
      sessionFile,
      subscribedEventCount,
      eventWarning,
      missingEvents,
      eventModeReady,
      redirectConfigured,
      redirectWarning,
    };
  }

  const base = {
    ok: true as const,
    sessionFile,
    sessionSource,
    cookieCount,
    scopeCount,
    skippedScopeCount: skipped.length,
    droppedScopes: requested.droppedScopes,
    scopeWarning,
    privilegeRangeCount,
    privilegeRangeWarning,
    subscribedEventCount,
    eventWarning,
    missingEvents,
    missingCallbacks,
    eventModeReady,
    redirectConfigured,
    redirectWarning,
  };
  if (options.publishVersion === false) return base;

  // 7) publish — skipped when nothing changed, unless just created / a draft is stuck / visibility requested.
  let versionList: unknown;
  try {
    versionList = await postJson(`/developers/v1/app_version/list/${appId}`, {});
  } catch (err) {
    await status(`读取版本列表失败（${safeErrorMessage(err)}），跳过草稿检查`);
  }
  const pendingDraft = versionList === undefined ? undefined : findUncommittedDraftVersionId(versionList);
  const mustPublish = options.appJustCreated === true || options.visibility !== undefined;
  if (!mutated && !mustPublish && !pendingDraft) {
    return { ...base, publishSkipped: true };
  }

  try {
    let visibility: { visibleSuggest: VisibilitySuggest; blackVisibleSuggest: VisibilitySuggest };
    try {
      visibility = parseOnlineVisibility(await postJson(`/developers/v1/visible/online/${appId}`, {}));
    } catch (err) {
      if (!(err instanceof VisibilityParseError)) throw err;
      return {
        ok: false,
        reason: 'visibility_unreadable',
        message: `无法可靠读取应用现有可见范围（${err.message}），已中止发版以免重置可见范围；请到开放平台手动发布新版本`,
        sessionFile,
        subscribedEventCount,
        eventWarning,
        missingEvents,
        eventModeReady,
        redirectConfigured,
        redirectWarning,
      };
    }
    visibility = { ...visibility, visibleSuggest: mergeVisibility(visibility.visibleSuggest, options.visibility) };
    const versions = versionList ?? await postJson(`/developers/v1/app_version/list/${appId}`, {});
    const draftVersionId = findUncommittedDraftVersionId(versions);
    let versionId: string | undefined;
    let versionReused = false;
    if (draftVersionId) {
      // A draft blocks create (code=10043). Its scope set is the app's current declared set,
      // which already includes what scope/update just added: commit it.
      versionId = draftVersionId;
      versionReused = true;
    } else {
      const payload = buildAppVersionCreatePayload(nextAppVersion(versions), [], options.versionRemark ?? 'Update bot configuration.') as unknown as Record<string, unknown>;
      payload.visibleSuggest = visibility.visibleSuggest;
      payload.blackVisibleSuggest = visibility.blackVisibleSuggest;
      versionId = extractVersionId(await postJson(`/developers/v1/app_version/create/${appId}`, payload));
    }
    let versionWarning: string | undefined;
    let approvalAutoPassed: boolean | undefined;
    let approvalHumanApprovers: string[] | undefined;
    if (versionId) {
      const prediction = await fetchApprovalFlowPrediction(postJson, appId, versionId, visibility);
      if (prediction.known) {
        approvalAutoPassed = prediction.autoApproved;
        if (prediction.humanApprovers.length > 0) approvalHumanApprovers = prediction.humanApprovers;
      } else if (prediction.reason) {
        await status(`审批流程预判不可用（${prediction.reason}），按常规提交`);
      }
      await postJson(`/developers/v1/publish/commit/${appId}/${versionId}`, { clientId: appId });
      try {
        if (!isVersionCommitted(await postJson(`/developers/v1/app_version/list/${appId}`, {}), versionId)) {
          versionWarning = `版本 ${versionId} 提交后回读仍是草稿：请到开放平台「版本管理」手动点「申请发布」`;
        }
      } catch (err) {
        versionWarning = `版本 ${versionId} 提交状态回读失败（无法确认是否已提交）: ${safeErrorMessage(err)}`;
      }
    } else {
      versionWarning = '开放平台没有返回新版本 versionId，可能留下了未提交的草稿';
    }
    return { ...base, versionId, versionReused, versionWarning, approvalAutoPassed, approvalHumanApprovers };
  } catch (err) {
    if (openPlatformUnderReview(err)) {
      return {
        ok: false,
        reason: 'app_under_review',
        message: '应用有版本正在审核中，暂时无法创建/提交新版本；审批结束后重试',
        sessionFile,
        subscribedEventCount,
        eventWarning,
        missingEvents,
        eventModeReady,
        redirectConfigured,
        redirectWarning,
      };
    }
    return fail(err, '开放平台发版失败', { subscribedEventCount, eventWarning, missingEvents, eventModeReady, redirectConfigured, redirectWarning });
  }
}
