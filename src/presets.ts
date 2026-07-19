/**
 * 默认权限清单与事件订阅清单。
 *
 * - 权限（scope）按能力分组导出，`DEFAULT_SCOPE_MANIFEST` 是推荐默认值：
 *   bot 收发消息 + 通讯录基础 + 应用自查 + **完整 VC 会议智能体权限**。
 * - 事件订阅同理：`DEFAULT_EVENTS` = 消息基线事件 + VC 会议事件。
 * - 需要更大权限面（docs / calendar / wiki 等）时传自定义 manifest 即可。
 */

export interface ScopeManifest {
  scopes?: {
    tenant?: string[];
    user?: string[];
  };
}

/** bot 收发消息 / 群管理 / 附件所需的核心 tenant 权限。 */
export const BOT_MESSAGING_TENANT_SCOPES = [
  'im:message',
  'im:message:readonly',
  'im:message:send_as_bot',
  'im:message:update',
  'im:message:recall',
  'im:message.group_msg',
  'im:message.group_at_msg:readonly',
  'im:message.group_at_msg.include_bot:readonly',
  'im:message.p2p_msg:readonly',
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

/** 通讯录基础读取（区分真人/机器人、取用户信息）。 */
export const CONTACT_TENANT_SCOPES = [
  'contact:contact.base:readonly',
  'contact:user.base:readonly',
  'contact:user.id:readonly',
] as const;

/** 应用自查（免审批，scope.list 自检需要）。 */
export const APP_SELF_MANAGE_SCOPES = ['application:application:self_manage'] as const;

/**
 * VC 会议智能体完整权限：入会/离会、实时语音发言、会中消息、会中事件流，
 * 以及会议 AI 辅助能力。
 */
export const VC_MEETING_TENANT_SCOPES = [
  'vc:meeting.bot.join:write',
  'vc:meeting.bot.realtime:write',
  'vc:meeting.message:write',
  'vc:meeting.meetingevent:read',
  'audio_video_ai:meeting_assistance',
] as const;

/** user 侧默认权限（`/login` 类 OAuth 场景的基础集）。 */
export const DEFAULT_USER_SCOPES = [
  'offline_access',
  'contact:contact.base:readonly',
  'im:message',
  'im:message:readonly',
  'vc:meeting.meetingevent:read',
] as const;

/** 推荐默认 manifest：消息 bot + 通讯录 + 自查 + 完整 VC 权限。 */
export const DEFAULT_SCOPE_MANIFEST: ScopeManifest = {
  scopes: {
    tenant: [
      ...BOT_MESSAGING_TENANT_SCOPES,
      ...CONTACT_TENANT_SCOPES,
      ...APP_SELF_MANAGE_SCOPES,
      ...VC_MEETING_TENANT_SCOPES,
    ],
    user: [...DEFAULT_USER_SCOPES],
  },
};

/**
 * 消息基线事件。开放平台内部 event/update 接口是**替换式**更新，每次提交都
 * 必须带全量事件列表，漏掉的会被静默退订。
 */
export const BOT_BASELINE_EVENTS = [
  'im.message.receive_v1',
  'card.action.trigger',
  'im.chat.member.bot.added_v1',
  'im.message.reaction.created_v1',
  'im.message.reaction.deleted_v1',
] as const;

/** VC 会议智能体推送事件。 */
export const VC_MEETING_BOT_EVENTS = [
  'vc.bot.meeting_invited_v1',
  'vc.bot.meeting_activity_v1',
  'vc.bot.meeting_ended_v1',
  'vc.meeting.participant_meeting_joined_v1',
] as const;

/** 默认订阅事件 = 消息基线 + VC 会议事件。 */
export const DEFAULT_EVENTS: string[] = [...BOT_BASELINE_EVENTS, ...VC_MEETING_BOT_EVENTS];
