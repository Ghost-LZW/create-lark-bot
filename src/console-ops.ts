/**
 * Payload builders and response parsers for the Open Platform console endpoints:
 * scopes, privilege data ranges, redirect whitelist, events/callbacks, versions,
 * approval-flow prediction.
 *
 * Ported from botmux (https://github.com/deepcoldy/botmux, MIT)
 * src/setup/open-platform-automation.ts. Behavioural notes from botmux's commit history
 * are kept next to the code they explain.
 */
import {
  OpenPlatformApiError,
  openPlatformOwnerAccessDenied,
  openPlatformWebSessionExpired,
  type OpenPlatformPostJson,
} from './console-client.js';
import type { ScopeManifest } from './presets.js';
import { asRecord, pickString, safeErrorMessage, uniqueStrings } from './util.js';
import type { VisibilitySuggest } from './visibility.js';

// ─── scopes ────────────────────────────────────────────────────────────────

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

export function mapManifestScopesToOpenPlatformIds(manifest: ScopeManifest, catalog: OpenPlatformScopeEntry[]): MappedScopeIds {
  const tenant = mapScopeIds(uniqueStrings(manifest.scopes?.tenant ?? []), catalog, 'tenant');
  const user = mapScopeIds(uniqueStrings(manifest.scopes?.user ?? []), catalog, 'user');
  return {
    tenantScopeIds: tenant.ids,
    userScopeIds: user.ids,
    missingTenantScopes: tenant.missing,
    missingUserScopes: user.missing,
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
    const nextBucket = /user/i.test(key) ? 'user' : /app|client|tenant/i.test(key) ? 'tenant' : bucket;
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

// ─── privilege data ranges («权限可访问的数据范围») ─────────────────────────
//
// A second chain independent of scope/update: some scopes carry a "data range" form
// (All / Same as app availability / Filter). Template-created apps are born with
// `mode:'all'`, which is exactly the tier tenant approval rules flag ("justify full-tenant
// data access"). We narrow required, not-yet-narrowed ranges to "same as app availability"
// (botmux #1061 / #1104). Writes merge by (bizId, resource).

export const PRIVILEGE_SCHEMA_TYPE_SELECTION_EXPRESSION = 1;
export const PRIVILEGE_ORG_TYPE_INTERNAL = 1;
export const PRIVILEGE_RANGE_SAME_AS_APP_AVAILABILITY = 'availability_of_app';

export interface OpenPlatformPrivilegeField {
  id: string;
  name: string;
  selectStaff: boolean;
  supportsIn: boolean;
}

export interface OpenPlatformPrivilege {
  raw: Record<string, unknown>;
  bizId: string;
  resource: string;
  name: string;
  bizName: string;
  isRequired: boolean;
  content: string;
  schemaType?: number;
  organizationType?: number;
  fields: OpenPlatformPrivilegeField[];
}

export function extractOpenPlatformPrivileges(payload: unknown): { privileges: OpenPlatformPrivilege[] } {
  const data = asRecord(asRecord(payload).data);
  const rawPrivileges = Array.isArray(data.privileges) ? data.privileges : [];
  const bizNames = new Map<string, string>();
  for (const biz of Array.isArray(data.scopeBiz) ? data.scopeBiz : []) {
    const record = asRecord(biz);
    const bizId = pickString(record, ['bizId', 'biz_id']);
    const bizName = pickString(record, ['bizName', 'biz_name']);
    if (bizId && bizName) bizNames.set(bizId, bizName);
  }
  const privileges: OpenPlatformPrivilege[] = [];
  for (const entry of rawPrivileges) {
    const record = asRecord(entry);
    const bizId = pickString(record, ['bizId', 'biz_id']);
    if (!bizId) continue;
    privileges.push({
      raw: record,
      bizId,
      resource: pickString(record, ['resource']) ?? '',
      name: pickString(record, ['name']) ?? '',
      bizName: bizNames.get(bizId) ?? '',
      isRequired: record.isRequired === true,
      content: pickString(record, ['content']) ?? '',
      schemaType: typeof record.schemaType === 'number' ? record.schemaType : undefined,
      organizationType: typeof record.organizationType === 'number' ? record.organizationType : undefined,
      fields: extractPrivilegeStaffFields(record),
    });
  }
  return { privileges };
}

export function canFillPrivilegeWithAppAvailability(privilege: OpenPlatformPrivilege): boolean {
  if (privilege.schemaType !== PRIVILEGE_SCHEMA_TYPE_SELECTION_EXPRESSION) return false;
  if (privilege.organizationType !== PRIVILEGE_ORG_TYPE_INTERNAL) return false;
  if (!privilege.fields.length) return false;
  return privilege.fields.every(field => field.selectStaff && field.supportsIn);
}

/** Byte-for-byte replica of what the console saves for "same as app availability". */
export function buildPrivilegeAppAvailabilityContent(privilege: OpenPlatformPrivilege): string {
  const filters = privilege.fields.map(field => ({
    field: field.id,
    value: JSON.stringify([{
      mode: PRIVILEGE_RANGE_SAME_AS_APP_AVAILABILITY,
      members: [] as string[],
      departments: [] as string[],
      groups: [] as string[],
    }]),
    operator: 'in',
  }));
  const description =
    `${privilege.bizName} - ${privilege.name}\n`
    + privilege.fields.map(field => `\t${field.name} 包含 与应用的可用范围一致 `).join('')
    + '\n';
  return JSON.stringify({
    biz_id: privilege.bizId,
    mode: 'part',
    resource: privilege.resource,
    filters,
    expression: filters.map((_, index) => index + 1).join(' and '),
    description,
  });
}

/** `mode:'all'`, empty, or `part` without filters all count as NOT narrowed. Unparseable → leave alone. */
export function isPrivilegeRangeNarrowed(privilege: OpenPlatformPrivilege): boolean {
  if (!privilege.content) return false;
  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(JSON.parse(privilege.content));
  } catch {
    return true;
  }
  const mode = parsed.mode;
  if (typeof mode !== 'string' || mode === '' || mode === 'all' || mode === 'null') return false;
  return Array.isArray(parsed.filters) && parsed.filters.length > 0;
}

export function selectPrivilegesNeedingAppAvailability(state: { privileges: OpenPlatformPrivilege[] }): OpenPlatformPrivilege[] {
  return state.privileges.filter(privilege =>
    privilege.isRequired && !isPrivilegeRangeNarrowed(privilege) && canFillPrivilegeWithAppAvailability(privilege));
}

export function buildPrivilegeUpdatePayload(appId: string, privileges: OpenPlatformPrivilege[]) {
  return {
    clientId: appId,
    privileges: privileges.map(privilege => ({ ...privilege.raw, content: buildPrivilegeAppAvailabilityContent(privilege) })),
  };
}

/** Read privilege/all and narrow the required, unnarrowed ranges. Returns how many were written. */
export async function narrowRequiredPrivilegeRanges(postJson: OpenPlatformPostJson, appId: string): Promise<number> {
  const state = extractOpenPlatformPrivileges(await postJson(`/developers/v1/privilege/all/${appId}`, {}));
  const needFill = selectPrivilegesNeedingAppAvailability(state);
  if (needFill.length === 0) return 0;
  await postJson(`/developers/v1/privilege/update/${appId}`, buildPrivilegeUpdatePayload(appId, needFill));
  return needFill.length;
}

function extractPrivilegeStaffFields(record: Record<string, unknown>): OpenPlatformPrivilegeField[] {
  const structured = asRecord(asRecord(record.schemaContent).selectionExpressionSchemaContent);
  let rawFields = Array.isArray(structured.fields) ? structured.fields : undefined;
  if (!rawFields) {
    const schemaText = pickString(record, ['schema']);
    if (schemaText) {
      try {
        const parsed = asRecord(asRecord(JSON.parse(schemaText)).schema_content);
        const inner = asRecord(parsed.SelectionExpressionSchemaContent);
        if (Array.isArray(inner.fields)) rawFields = inner.fields;
      } catch {
        // not JSON → treated as no fields
      }
    }
  }
  if (!rawFields) return [];
  const fields: OpenPlatformPrivilegeField[] = [];
  for (const entry of rawFields) {
    const field = asRecord(entry);
    const id = pickString(field, ['id']);
    if (!id) continue;
    const operators = Array.isArray(field.operators) ? field.operators : [];
    fields.push({
      id,
      name: pickString(field, ['name']) ?? '',
      selectStaff: pickString(asRecord(field.data_source), ['type']) === 'select_staff',
      supportsIn: operators.includes('in'),
    });
  }
  return fields;
}

// ─── redirect whitelist (safe_setting) ─────────────────────────────────────

/** `safe_setting/update` is FULL-OVERWRITE: callers must merge with the live list first. */
export function buildSafeSettingPayload(appId: string, redirectUrls: string[]) {
  return { clientId: appId, redirectURL: uniqueStrings(redirectUrls) };
}

/** `null` = could not read (different from "read an empty list"). */
export function extractOpenPlatformRedirectUrls(payload: unknown): string[] | null {
  const root = asRecord(payload);
  const wrapped = asRecord(root.data);
  const data = Object.keys(wrapped).length > 0 ? wrapped : root;
  const raw = data.redirectURL ?? data.redirectUrl ?? data.redirectURLs;
  if (!Array.isArray(raw)) {
    // New apps omit `redirectURL` when the list is empty; accept that only when the other
    // safe_setting fields have their known shape (botmux #1223).
    const omittedEmptyList = raw === undefined
      && typeof data.allowRefreshToken === 'boolean'
      && Array.isArray(data.ipWhiteList)
      && Array.isArray(data.safeServerDomain);
    return omittedEmptyList ? [] : null;
  }
  return uniqueStrings(raw.map(item => (typeof item === 'string' ? item.trim() : '')));
}

export interface RedirectWhitelistWriteResult {
  /** unchanged = idempotent no-op; skipped_unreadable = could not read and blind write not allowed (zero writes). */
  status: 'unchanged' | 'updated' | 'updated_fallback' | 'skipped_unreadable';
  existing: string[] | null;
  redirectUrls: string[];
  warning?: string;
}

export function missingRedirectUrls(wanted: string[], written: string[]): string[] {
  const live = new Set(written);
  return uniqueStrings(wanted).filter(url => !live.has(url));
}

/**
 * Read → merge → write the redirect whitelist; never deletes entries the user configured.
 * When the live list cannot be read, writes nothing unless `allowBlindWrite` (only for an
 * app created in this very run — its list is necessarily empty).
 */
export async function writeRedirectWhitelist(
  postJson: OpenPlatformPostJson,
  appId: string,
  wanted: string[],
  options: { allowBlindWrite?: boolean } = {},
): Promise<RedirectWhitelistWriteResult> {
  let existing: string[] | null = null;
  let readError: string | undefined;
  try {
    existing = extractOpenPlatformRedirectUrls(await postJson(`/developers/v1/safe_setting/${appId}`, {}));
    if (existing === null) readError = '返回体里没有可识别的 redirectURL 数组';
  } catch (err) {
    if (openPlatformWebSessionExpired(err)) throw err;
    existing = null;
    readError = safeErrorMessage(err);
  }
  if (existing === null && !options.allowBlindWrite) {
    return {
      status: 'skipped_unreadable',
      existing: null,
      redirectUrls: [],
      warning: `读不到开放平台现有 redirect 白名单（${readError ?? '未知原因'}），为避免覆盖已有回调地址，本次未写入`,
    };
  }
  const wantedUrls = uniqueStrings(wanted);
  if (existing !== null && wantedUrls.every(url => existing!.includes(url))) {
    return { status: 'unchanged', existing, redirectUrls: existing };
  }
  const merged = existing === null ? wantedUrls : uniqueStrings([...existing, ...wantedUrls]);
  const mergedPayload = buildSafeSettingPayload(appId, merged);
  try {
    await postJson(`/developers/v1/safe_setting/update/${appId}`, mergedPayload);
    return { status: 'updated', existing, redirectUrls: mergedPayload.redirectURL };
  } catch (err) {
    if (!isRedirectUrlRejectedError(err)) throw err;
    // One URL judged invalid fails the whole batch: retry with live ∪ the first wanted URL.
    const minimal = buildSafeSettingPayload(appId, uniqueStrings([...(existing ?? []), ...wantedUrls.slice(0, 1)]));
    if (minimal.redirectURL.length === mergedPayload.redirectURL.length) throw err;
    try {
      await postJson(`/developers/v1/safe_setting/update/${appId}`, minimal);
    } catch (fallbackErr) {
      throw new Error(`全集与最小集兜底两次写入均失败（最小集: ${safeErrorMessage(fallbackErr)}）`, { cause: err });
    }
    return { status: 'updated_fallback', existing, redirectUrls: minimal.redirectURL };
  }
}

const matchesRedirectSubject = keywordMatcher(['url', 'uri', 'redirect', 'callback', '回调', '重定向', '链接']);
const matchesRedirectRejection = keywordMatcher([
  'invalid', 'illegal', 'malformed', 'format', 'not allowed', 'not supported', 'unsupported',
  '非法', '不合法', '格式', '不支持', '不允许',
]);

function keywordMatcher(keywords: string[]): (message: string) => boolean {
  const isAscii = (k: string) => /^[\x20-\x7e]+$/.test(k);
  const ascii = keywords.filter(isAscii).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const cjk = keywords.filter(k => !isAscii(k));
  const pattern = ascii.length ? new RegExp(`\\b(?:${ascii.join('|')})s?\\b`, 'i') : null;
  return message => (pattern?.test(message) ?? false) || cjk.some(k => message.includes(k));
}

/** Only "this URL is invalid" errors justify the minimal-set retry; never network/auth/rate-limit. */
function isRedirectUrlRejectedError(err: unknown): boolean {
  if (!(err instanceof OpenPlatformApiError)) return false;
  if ([401, 403, 408, 409, 429].includes(err.status) || err.status >= 500) return false;
  if (openPlatformOwnerAccessDenied(err)) return false;
  const message = safeErrorMessage(err);
  return matchesRedirectSubject(message) && matchesRedirectRejection(message);
}

// ─── events & callbacks ─────────────────────────────────────────────────────

/** Open Platform "receive events/callbacks over a long connection (WebSocket)" mode value. */
export const LONG_CONNECTION_EVENT_MODE = 4;

/**
 * Console `updateEvent` contract: `{clientId, operation:'add', events, appEvents, userEvents, eventMode}`.
 * The old `eventNames` / `eventNameList` bodies and `/event_callback/update` endpoint do not exist
 * (botmux 9f8a389a) — new apps ended up with no subscriptions at all.
 */
export function buildEventSubscriptionPayload(
  appId: string,
  eventMode: number,
  appEvents: string[],
  userEvents: string[],
  events: string[] = [],
) {
  return { clientId: appId, operation: 'add', events, appEvents, userEvents, eventMode };
}

export function buildCallbackSubscriptionPayload(appId: string, callbackMode: number, callbacks: string[]) {
  return { clientId: appId, operation: 'add', callbacks, callbackMode };
}

export interface OpenPlatformEventState {
  eventMode?: number;
  events: string[];
  appEvents: string[];
  userEvents: string[];
}

export interface OpenPlatformCallbackState {
  callbackMode?: number;
  callbacks: string[];
}

export function extractOpenPlatformEventState(payload: unknown): OpenPlatformEventState {
  const root = asRecord(payload);
  const wrapped = asRecord(root.data);
  const data = Object.keys(wrapped).length > 0 ? wrapped : root;
  const appEvents = uniqueStrings([...eventIds(data.appEvents), ...eventIdsFromDetails(data.appEventDetails)]);
  const userEvents = uniqueStrings([...eventIds(data.userEvents), ...eventIdsFromDetails(data.userEventDetails)]);
  const generic = uniqueStrings([...eventIds(data.events), ...eventIdsFromDetails(data.eventDetails)]);
  const eventMode = typeof data.eventMode === 'number' && Number.isFinite(data.eventMode) ? data.eventMode : undefined;
  return { eventMode, events: uniqueStrings([...generic, ...appEvents, ...userEvents]), appEvents, userEvents };
}

export function extractOpenPlatformCallbackState(payload: unknown): OpenPlatformCallbackState {
  const root = asRecord(payload);
  const wrapped = asRecord(root.data);
  const data = Object.keys(wrapped).length > 0 ? wrapped : root;
  const callbackMode = typeof data.callbackMode === 'number' && Number.isFinite(data.callbackMode) ? data.callbackMode : undefined;
  return { callbackMode, callbacks: eventIds(data.callbacks) };
}

function eventIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value
    .map(item => (typeof item === 'string' ? item : pickString(asRecord(item), ['id'])))
    .filter((item): item is string => Boolean(item)));
}

function eventIdsFromDetails(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.flatMap(group => eventIds(asRecord(group).items)));
}

// ─── versions ───────────────────────────────────────────────────────────────

/**
 * Version payload matching the console's one-click agent launcher. Do NOT add back
 * `applyReasonConfig` / `isAutoAudit:false` — that forces manual review and the app stays
 * "not enabled". `visibleSuggest` overwrites visibility: only a brand-new app's first
 * version may use this default; existing apps must mirror `visible/online`.
 */
export function buildAppVersionCreatePayload(appVersion: string, visibleMemberIds: string[] = [], changeLog = 'Initial bot release.') {
  return {
    appVersion,
    mobileDefaultAbility: 'bot',
    pcDefaultAbility: 'bot',
    changeLog,
    visibleSuggest: { departments: [] as string[], members: visibleMemberIds, groups: [] as string[], isAll: 0 },
    blackVisibleSuggest: { departments: [] as string[], members: [] as string[], groups: [] as string[], isAll: 0 },
  };
}

/** Max x.y.z across ALL versions (drafts included) + 1 — a stale draft must not cause a collision. */
export function nextAppVersion(payload: unknown): string {
  const data = asRecord(asRecord(payload).data);
  const versions = Array.isArray(data.versions) ? data.versions : [];
  const triples = versions
    .map(item => pickString(asRecord(item), ['appVersion']))
    .filter((v): v is string => Boolean(v))
    .map(v => v.split('.').map(part => Number.parseInt(part, 10)))
    .filter(parts => parts.length === 3 && parts.every(part => Number.isFinite(part)));
  if (triples.length === 0) return '0.0.1';
  const max = triples.reduce((a, b) => {
    for (let i = 0; i < 3; i++) if (b[i] !== a[i]) return b[i] > a[i] ? b : a;
    return a;
  });
  return [max[0], max[1], max[2] + 1].join('.');
}

/** console `versionStatus`: 0 draft, 1 in review, 2 online, 100 historical online. */
export const CONSOLE_VERSION_STATUS_DRAFT = 0;
export const CONSOLE_VERSION_STATUS_IN_REVIEW = 1;

function findVersionIdWithStatus(payload: unknown, status: number): string | undefined {
  const data = asRecord(asRecord(payload).data);
  for (const item of Array.isArray(data.versions) ? data.versions : []) {
    const record = asRecord(item);
    if (record.versionStatus !== status) continue;
    const versionId = pickString(record, ['versionId', 'version_id', 'id']);
    if (versionId) return versionId;
  }
  return undefined;
}

/** An uncommitted draft blocks `app_version/create` (code=10043); commit it instead of creating. */
export function findUncommittedDraftVersionId(payload: unknown): string | undefined {
  return findVersionIdWithStatus(payload, CONSOLE_VERSION_STATUS_DRAFT);
}

export function findInReviewVersionId(payload: unknown): string | undefined {
  return findVersionIdWithStatus(payload, CONSOLE_VERSION_STATUS_IN_REVIEW);
}

/** `publish/commit` returning code=0 does not prove the version left draft state; read back. */
export function isVersionCommitted(payload: unknown, versionId: string): boolean {
  const data = asRecord(asRecord(payload).data);
  for (const item of Array.isArray(data.versions) ? data.versions : []) {
    const record = asRecord(item);
    if (pickString(record, ['versionId', 'version_id', 'id']) !== versionId) continue;
    return record.versionStatus !== CONSOLE_VERSION_STATUS_DRAFT;
  }
  return false;
}

export function extractVersionId(payload: unknown): string | undefined {
  const direct = pickString(asRecord(payload), ['versionId', 'version_id', 'id']);
  if (direct) return direct;
  const data = asRecord(asRecord(payload).data);
  return pickString(data, ['versionId', 'version_id', 'id']) ?? pickString(asRecord(data.appVersion), ['versionId', 'version_id', 'id']);
}

/**
 * Withdraw an in-review version (console "Withdraw" button). Never called automatically:
 * an approval is triggered by a rule; withdrawing and resubmitting hits the same rule and
 * only loses the queue position. Exposed for explicit, human-initiated use.
 */
export async function cancelPendingReviewVersion(
  postJson: OpenPlatformPostJson,
  appId: string,
  versionId: string,
): Promise<{ ok: boolean; message?: string }> {
  try {
    await postJson(`/developers/v1/publish/cancel_commit/${appId}/${versionId}`, {});
  } catch (err) {
    return { ok: false, message: `撤回审核中版本失败: ${safeErrorMessage(err)}` };
  }
  try {
    const after = await postJson(`/developers/v1/app_version/list/${appId}`, {});
    if (findInReviewVersionId(after) === versionId) {
      return { ok: false, message: `版本 ${versionId} 撤回后回读仍是「审核中」` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: `撤回后状态回读失败（无法确认）: ${safeErrorMessage(err)}` };
  }
}

export interface ApprovalFlowPrediction {
  known: boolean;
  autoApproved: boolean;
  humanApprovers: string[];
  reason?: string;
}

const APPROVAL_FLOW_NON_GATE_NODES = new Set(['发起', '结束', 'Initiate', 'End']);
const APPROVAL_FLOW_AUTO_NODE_TYPES = new Set(['自动通过', 'Auto approved']);

/** Parse `approval_nodes/get` (`data.applyInstanceInfo.applyNodes`); cc-only nodes are not gates. */
export function predictApprovalFlow(payload: unknown): ApprovalFlowPrediction {
  const nodes = asRecord(asRecord(asRecord(payload).data).applyInstanceInfo).applyNodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { known: false, autoApproved: false, humanApprovers: [], reason: '审批流程为空（可能没有待发布版本）' };
  }
  const gates = nodes.map(node => asRecord(node)).filter(node => {
    const name = pickString(node, ['nodeName']) ?? '';
    if (APPROVAL_FLOW_NON_GATE_NODES.has(name)) return false;
    const cc = Array.isArray(node.nodeCcUser) ? node.nodeCcUser : [];
    const users = Array.isArray(node.nodeUser) ? node.nodeUser : [];
    return !(cc.length > 0 && users.length === 0);
  });
  if (gates.length === 0) {
    return { known: false, autoApproved: false, humanApprovers: [], reason: '审批流程里没有可判定的关卡节点' };
  }
  const humanApprovers: string[] = [];
  for (const gate of gates) {
    for (const entry of Array.isArray(gate.nodeUser) ? gate.nodeUser : []) {
      const name = pickString(asRecord(asRecord(entry).approver), ['name', 'enName']);
      if (name) humanApprovers.push(name);
    }
  }
  const allAuto = gates.every(gate => APPROVAL_FLOW_AUTO_NODE_TYPES.has(pickString(gate, ['nodeType']) ?? ''));
  return { known: true, autoApproved: allAuto && humanApprovers.length === 0, humanApprovers: uniqueStrings(humanApprovers) };
}

export async function fetchApprovalFlowPrediction(
  postJson: OpenPlatformPostJson,
  appId: string,
  versionId: string,
  visibility: { visibleSuggest: VisibilitySuggest; blackVisibleSuggest: VisibilitySuggest },
): Promise<ApprovalFlowPrediction> {
  try {
    const payload = await postJson(`/developers/v1/approval_nodes/get/${appId}`, {
      visibleSuggest: visibility.visibleSuggest,
      blackVisibleSuggest: visibility.blackVisibleSuggest,
      b2cShareSplitConfigSuggest: { b2cGroupChatShareEnable: false, b2cP2PChatShareEnable: false, b2cP2PChatNeedAudit: false },
      versionId,
      notCalculateFlow: false,
    });
    return predictApprovalFlow(payload);
  } catch (err) {
    return { known: false, autoApproved: false, humanApprovers: [], reason: safeErrorMessage(err) };
  }
}
