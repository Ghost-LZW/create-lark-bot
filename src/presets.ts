/**
 * Composable scope / event / callback presets.
 *
 * A preset is a small capability bundle; compose the ones you need:
 *
 * ```ts
 * const manifest = composePresets('messagingCore', 'contact', { scopes: { tenant: ['docx:document:readonly'] } });
 * ```
 *
 * `DEFAULT_*` keep the 0.1.x defaults (messaging + contact + self-manage + full VC meeting),
 * refreshed against botmux's current scope manifest and event lists.
 *
 * Scope names are checked in tests against {@link FULL_TENANT_SCOPES}/{@link FULL_USER_SCOPES}
 * (botmux's lark-scopes.json) so a typo or an auto-rejected scope cannot slip in.
 */
import { FULL_TENANT_SCOPES, FULL_USER_SCOPES } from './full-scopes.js';

export { FULL_TENANT_SCOPES, FULL_USER_SCOPES };

/** Shape of the console's "batch import/export scopes" JSON (and the SDK `addons.scopes`). */
export interface ScopeManifest {
  scopes?: {
    tenant?: string[];
    user?: string[];
  };
}

/** One capability bundle. Every field is optional and additive. */
export interface BotPreset {
  scopes?: { tenant?: readonly string[]; user?: readonly string[] };
  /** Event subscriptions by receiving identity: `app` (tenant) or `user`. */
  events?: { app?: readonly string[]; user?: readonly string[] };
  /** Callbacks (configured separately from events), e.g. `card.action.trigger`. */
  callbacks?: readonly string[];
}

/** The fully-resolved, de-duplicated result of {@link composePresets}. */
export interface BotManifest {
  scopes: { tenant: string[]; user: string[] };
  events: { app: string[]; user: string[] };
  callbacks: string[];
}

// ─── building blocks (kept as named exports for 0.1.x compatibility) ────────

/** The minimum for a bot that receives messages and replies (incl. interactive cards). */
export const MESSAGING_CORE_TENANT_SCOPES = [
  'im:message:send_as_bot',
  'im:message',
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
] as const;

/** bot 收发消息 / 群管理 / 附件 / 卡片所需的 tenant 权限（含 core）。 */
export const BOT_MESSAGING_TENANT_SCOPES = [
  ...MESSAGING_CORE_TENANT_SCOPES,
  'im:message:readonly',
  'im:message:update',
  'im:message:recall',
  'im:message.group_msg',
  'im:message.group_at_msg.include_bot:readonly',
  'im:message.reactions:read',
  'im:message.reactions:write_only',
  'im:resource',
  'im:chat:create',
  'im:chat:read',
  'im:chat:update',
  'im:chat.members:bot_access',
  'im:chat.members:read',
  'im:chat.members:write_only',
  'cardkit:card:read',
  'cardkit:card:write',
] as const;

/** 通讯录基础读取（区分真人/机器人、取用户信息、把扫码人解析成 union_id）。 */
export const CONTACT_TENANT_SCOPES = [
  'contact:contact.base:readonly',
  'contact:user.base:readonly',
  'contact:user.id:readonly',
] as const;

/** 应用自查（免审批）：`verify` 读回已授权 scope 需要它。 */
export const APP_SELF_MANAGE_SCOPES = ['application:application:self_manage'] as const;

/** VC 会议智能体完整权限：入会/离会、实时语音、会中消息、会中事件流、会议 AI 辅助。 */
export const VC_MEETING_TENANT_SCOPES = [
  'vc:meeting.bot.join:write',
  'vc:meeting.bot.realtime:write',
  'vc:meeting.message:write',
  'vc:meeting.meetingevent:read',
  'audio_video_ai:meeting_assistance',
] as const;

/** user 侧默认权限（OAuth `/login` 类场景的基础集）。 */
export const DEFAULT_USER_SCOPES = [
  'offline_access',
  'contact:contact.base:readonly',
  'im:message',
  'im:message:readonly',
  'vc:meeting.meetingevent:read',
] as const;

/** Message events the bot needs to function (`im.message.receive_v1` is the critical one). */
export const BOT_BASELINE_EVENTS = [
  'im.message.receive_v1',
  'im.chat.member.bot.added_v1',
  'im.chat.member.bot.deleted_v1',
  'im.message.reaction.created_v1',
  'im.message.reaction.deleted_v1',
] as const;

/** Best-effort extras (membership change, message edited); a failure never blocks setup. */
export const BOT_OPTIONAL_EVENTS = [
  'im.chat.member.user.added_v1',
  'im.chat.member.user.deleted_v1',
  'im.message.updated_v1',
] as const;

/** VC 会议智能体推送事件（participant_meeting_joined 是 user 身份事件）。 */
export const VC_MEETING_BOT_EVENTS = [
  'vc.bot.meeting_invited_v1',
  'vc.bot.meeting_activity_v1',
  'vc.bot.meeting_ended_v1',
  'vc.meeting.participant_meeting_joined_v1',
] as const;
export const VC_MEETING_APP_EVENTS = ['vc.bot.meeting_invited_v1', 'vc.bot.meeting_activity_v1', 'vc.bot.meeting_ended_v1'] as const;
export const VC_MEETING_USER_EVENTS = ['vc.meeting.participant_meeting_joined_v1'] as const;

/** Doc comment notifications (app identity). */
export const DOC_COMMENT_EVENT = 'drive.notice.comment_add_v1';

/** Card interaction callback — a "callback", not an event, on the Open Platform. */
export const CARD_ACTION_CALLBACK = 'card.action.trigger';

/** Events that only exist as user-identity subscriptions. */
const KNOWN_USER_EVENTS = new Set<string>([...VC_MEETING_USER_EVENTS]);
/** Names that are callbacks, not events. */
const KNOWN_CALLBACKS = new Set<string>([CARD_ACTION_CALLBACK, 'url.preview.get']);

// ─── presets ─────────────────────────────────────────────────────────────────

export const presets = {
  /** Receive DMs and @mentions, reply as the bot, card button callbacks. */
  messagingCore: {
    scopes: { tenant: MESSAGING_CORE_TENANT_SCOPES },
    events: { app: ['im.message.receive_v1'] },
    callbacks: [CARD_ACTION_CALLBACK],
  },
  /** Full chat bot: core + every group message, attachments, reactions, chat management, cardkit. */
  messaging: {
    scopes: { tenant: BOT_MESSAGING_TENANT_SCOPES },
    events: { app: [...BOT_BASELINE_EVENTS, ...BOT_OPTIONAL_EVENTS] },
    callbacks: [CARD_ACTION_CALLBACK],
  },
  /** Contact base reads; also what owner resolution (open_id/email → union_id) needs. */
  contact: { scopes: { tenant: CONTACT_TENANT_SCOPES } },
  /** Lets `verify` read back the granted scopes (application v6). Needs no approval. */
  selfManage: { scopes: { tenant: APP_SELF_MANAGE_SCOPES } },
  /** VC meeting agent: join/leave, realtime voice, in-meeting messages and events. */
  vcMeeting: {
    scopes: { tenant: VC_MEETING_TENANT_SCOPES, user: ['vc:meeting.meetingevent:read'] },
    events: { app: VC_MEETING_APP_EVENTS, user: VC_MEETING_USER_EVENTS },
  },
  /** OAuth user login basics (refresh token + identity + messages). */
  userLogin: { scopes: { user: DEFAULT_USER_SCOPES } },
  /** Docs: read/write docx, comments (incl. comment notifications), drive files, wiki read. */
  docs: {
    scopes: {
      tenant: [
        'docx:document:readonly', 'docx:document:create', 'docx:document:write_only', 'docx:document.block:convert',
        'docs:document.content:read', 'docs:document.comment:read', 'docs:document.comment:create',
        'docs:document.subscription', 'docs:event:subscribe', 'docs:document.media:download', 'docs:document.media:upload',
        'drive:drive.metadata:readonly', 'drive:file:download', 'drive:file:upload', 'wiki:wiki:readonly',
      ],
      user: [
        'docx:document:readonly', 'docx:document:create', 'docx:document:write_only',
        'docs:document.content:read', 'docs:document.comment:read', 'docs:document.comment:create',
        'drive:drive.metadata:readonly', 'drive:file:download', 'wiki:wiki:readonly',
      ],
    },
    events: { app: [DOC_COMMENT_EVENT] },
  },
  /** Wiki spaces and nodes. */
  wiki: {
    scopes: {
      tenant: ['wiki:wiki:readonly', 'wiki:space:read', 'wiki:space:retrieve', 'wiki:node:read', 'wiki:node:retrieve', 'wiki:node:create', 'wiki:node:update'],
      user: ['wiki:wiki:readonly', 'wiki:space:read', 'wiki:space:retrieve', 'wiki:node:read', 'wiki:node:retrieve'],
    },
  },
  /** Sheets. */
  sheets: {
    scopes: {
      tenant: ['sheets:spreadsheet:read', 'sheets:spreadsheet:create', 'sheets:spreadsheet:write_only', 'sheets:spreadsheet.meta:read'],
      user: ['sheets:spreadsheet:read', 'sheets:spreadsheet:create', 'sheets:spreadsheet:write_only', 'sheets:spreadsheet.meta:read'],
    },
  },
  /** Base / Bitable (botmux #1506). */
  base: { scopes: { tenant: ['base:app:create', 'bitable:app'], user: ['base:app:create', 'bitable:app'] } },
  /** Calendar read/write. */
  calendar: {
    scopes: {
      tenant: ['calendar:calendar:read', 'calendar:calendar.event:read', 'calendar:calendar.event:create', 'calendar:calendar.event:update', 'calendar:calendar.free_busy:read'],
      user: ['calendar:calendar:read', 'calendar:calendar.event:read', 'calendar:calendar.event:create', 'calendar:calendar.event:update', 'calendar:calendar.free_busy:read'],
    },
  },
  /** Tasks. */
  tasks: { scopes: { tenant: ['task:task:read', 'task:task:write', 'task:tasklist:read', 'task:tasklist:write'] } },
  /** Buzz/urgent messages (sms/phone consume tenant quota). */
  urgent: { scopes: { tenant: ['im:message.urgent', 'im:message.urgent:sms', 'im:message.urgent:phone'], user: ['im:message.urgent.status:write'] } },
  /** Group tabs management. */
  chatTabs: { scopes: { tenant: ['im:chat.tabs:read', 'im:chat.tabs:write_only'], user: ['im:chat.tabs:read', 'im:chat.tabs:write_only'] } },
  /** Feed groups (conversation tags) — user identity only. */
  feedGroups: { scopes: { user: ['im:feed_group_v1:read', 'im:feed_group_v1:write'] } },
  /** Everything botmux requests (300 scopes). Large: expect a long approval and a large SDK QR. */
  full: {
    scopes: { tenant: FULL_TENANT_SCOPES, user: FULL_USER_SCOPES },
    events: {
      app: [...BOT_BASELINE_EVENTS, ...BOT_OPTIONAL_EVENTS, DOC_COMMENT_EVENT, ...VC_MEETING_APP_EVENTS],
      user: VC_MEETING_USER_EVENTS,
    },
    callbacks: [CARD_ACTION_CALLBACK],
  },
} as const satisfies Record<string, BotPreset>;

export type PresetName = keyof typeof presets;
export const PRESET_NAMES = Object.keys(presets) as PresetName[];

export function isPresetName(name: string): name is PresetName {
  return Object.prototype.hasOwnProperty.call(presets, name);
}

/** Union of presets (by name or inline), de-duplicated, order-preserving. */
export function composePresets(...parts: Array<PresetName | BotPreset | undefined>): BotManifest {
  const out = { tenant: [] as string[], user: [] as string[], app: [] as string[], userEvents: [] as string[], callbacks: [] as string[] };
  for (const part of parts) {
    if (!part) continue;
    const preset: BotPreset = typeof part === 'string' ? presetByName(part) : part;
    out.tenant.push(...(preset.scopes?.tenant ?? []));
    out.user.push(...(preset.scopes?.user ?? []));
    out.app.push(...(preset.events?.app ?? []));
    out.userEvents.push(...(preset.events?.user ?? []));
    out.callbacks.push(...(preset.callbacks ?? []));
  }
  const u = (a: string[]) => [...new Set(a.filter(Boolean))];
  return {
    scopes: { tenant: u(out.tenant), user: u(out.user) },
    events: { app: u(out.app), user: u(out.userEvents) },
    callbacks: u(out.callbacks),
  };
}

function presetByName(name: string): BotPreset {
  if (!isPresetName(name)) throw new Error(`Unknown preset "${name}". Known: ${PRESET_NAMES.join(', ')}`);
  return presets[name];
}

/**
 * Split a flat event list (the 0.1.x `events` option) into app events, user events and
 * callbacks. `card.action.trigger` used to be listed as an event; it is a callback.
 */
export function classifyEventNames(names: readonly string[]): BotManifest['events'] & { callbacks: string[] } {
  const app: string[] = [];
  const user: string[] = [];
  const callbacks: string[] = [];
  for (const name of names) {
    if (KNOWN_CALLBACKS.has(name)) callbacks.push(name);
    else if (KNOWN_USER_EVENTS.has(name)) user.push(name);
    else app.push(name);
  }
  return { app: [...new Set(app)], user: [...new Set(user)], callbacks: [...new Set(callbacks)] };
}

/** The scope part of a manifest, in the console batch-import JSON shape. */
export function toScopeManifest(manifest: Pick<BotManifest, 'scopes'>): Required<ScopeManifest> & { scopes: { tenant: string[]; user: string[] } } {
  return { scopes: { tenant: [...manifest.scopes.tenant], user: [...manifest.scopes.user] } };
}

/** Default bot: messaging + contact + self-manage + full VC meeting (+ user login basics). */
export const DEFAULT_PRESETS: readonly PresetName[] = ['messaging', 'contact', 'selfManage', 'vcMeeting', 'userLogin'];
export const DEFAULT_MANIFEST: BotManifest = composePresets(...DEFAULT_PRESETS);

/** 推荐默认 scope manifest（与 0.1.x 同组成，按 botmux 当前清单刷新）。 */
export const DEFAULT_SCOPE_MANIFEST: ScopeManifest = toScopeManifest(DEFAULT_MANIFEST);

/**
 * Default event subscriptions (app + user identity). 0.2.0: no longer contains
 * `card.action.trigger` — see {@link DEFAULT_CALLBACKS}.
 */
export const DEFAULT_EVENTS: string[] = [...DEFAULT_MANIFEST.events.app, ...DEFAULT_MANIFEST.events.user];
export const DEFAULT_CALLBACKS: string[] = [...DEFAULT_MANIFEST.callbacks];

/** The full botmux manifest in console batch-import shape. */
export const FULL_SCOPE_MANIFEST: ScopeManifest = toScopeManifest(composePresets('full'));

/**
 * Scopes Feishu lists as "not open — auto-rejected": requesting any of them makes the
 * whole publish request get auto-rejected without naming the culprit (botmux #1326).
 */
export const AUTO_REJECTED_SCOPES = [
  'im:app_feed_card:write',
  'im:url_preview.update',
  'im:special_focus',
  'drive:file:favorite',
  'drive:file:favorite:readonly',
] as const;
