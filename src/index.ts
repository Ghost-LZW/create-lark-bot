export {
  createLarkBot,
  updateLarkBot,
  type CreateLarkBotOptions,
  type CreateLarkBotResult,
  type UpdateLarkBotOptions,
  type UpdateLarkBotResult,
  type CreateMode,
  type CreatedIdentity,
  type ManifestOptions,
} from './create-bot.js';

export {
  createFeishuOpenPlatformApp,
  createOpenPlatformAppWithClient,
  resolveConsoleIdentity,
  uploadAppIcon,
  listOpenPlatformApps,
  fetchOpenPlatformAppSecret,
  buildManifestTemplateCreatePayload,
  buildPlainAppCreatePayload,
  CreatedOpenPlatformAppError,
  ONECLICK_APP_MANIFEST_TEMPLATE_ID,
  type CreateFeishuAppOptions,
  type CreateFeishuAppResult,
  type CreateWithClientOptions,
  type OpenPlatformAppSummary,
  type ResolvedIdentity,
} from './create-app.js';

export { selectExistingApp, type SelectExistingAppOptions, type SelectExistingAppResult } from './existing-app.js';
export { updateOpenPlatformAppIdentity, parseBaseInfoSnapshot, type UpdateIdentityResult } from './update-app.js';

export {
  registerLarkApp,
  buildSdkAppPreset,
  buildSdkAddons,
  type RegisterAppOptions,
  type RegisterAppResult,
  type RegisterAppOk,
  type RegisterAppErr,
  type RegisterBrand,
  type SdkAppPreset,
  type SdkAppAddons,
} from './register-app.js';

export {
  configureOpenPlatformApp,
  resolveRequestedManifest,
  type ConfigureAppOptions,
  type ConfigureAppResult,
  type ConfigureFailureReason,
} from './open-platform.js';

export {
  createOpenPlatformApiClient,
  extractOpenPlatformCsrfToken,
  extractOpenPlatformSessionIdentity,
  openPlatformWebSessionExpired,
  openPlatformUnderReview,
  openPlatformOwnerAccessDenied,
  OpenPlatformApiError,
  type OpenPlatformApiClient,
  type OpenPlatformClientResult,
  type OpenPlatformPostJson,
  type WebSessionIdentity,
} from './console-client.js';

export {
  buildScopeUpdatePayload,
  buildSafeSettingPayload,
  buildEventSubscriptionPayload,
  buildCallbackSubscriptionPayload,
  buildAppVersionCreatePayload,
  buildPrivilegeUpdatePayload,
  buildPrivilegeAppAvailabilityContent,
  extractOpenPlatformScopeEntries,
  extractOpenPlatformEventState,
  extractOpenPlatformCallbackState,
  extractOpenPlatformPrivileges,
  extractOpenPlatformRedirectUrls,
  mapManifestScopesToOpenPlatformIds,
  narrowRequiredPrivilegeRanges,
  writeRedirectWhitelist,
  missingRedirectUrls,
  nextAppVersion,
  extractVersionId,
  findUncommittedDraftVersionId,
  findInReviewVersionId,
  isVersionCommitted,
  cancelPendingReviewVersion,
  predictApprovalFlow,
  fetchApprovalFlowPrediction,
  LONG_CONNECTION_EVENT_MODE,
  type OpenPlatformScopeEntry,
  type MappedScopeIds,
  type ApprovalFlowPrediction,
  type RedirectWhitelistWriteResult,
} from './console-ops.js';

export {
  parseOnlineVisibility,
  mergeVisibility,
  VisibilityParseError,
  type VisibilitySuggest,
  type VisibilityAdditions,
} from './visibility.js';

export {
  prepareWebSession,
  validateWebSession,
  defaultSessionFilePath,
  readStoredCookiesFromSessionFile,
  writeStoredCookiesToSessionFile,
  getCookieHeader,
  buildQrLoginPayload,
  mapQrPollingStatus,
  MutableCookieJar,
  WebSessionError,
  type StoredCookie,
  type WebSessionOptions,
  type WebSessionPrepareResult,
  type WebSessionSource,
  type WebSessionFailureReason,
} from './web-session.js';

export {
  DEFAULT_APP_NAME,
  DEFAULT_APP_DESCRIPTION,
  AVATAR_IMAGE_SIZE,
  AVATAR_IMAGE_MAX_BYTES,
  applyUserPlaceholder,
  pickAvailableName,
  validateAvatarPng,
  loadAvatar,
  defaultAppIcon,
  IdentityError,
  AvatarError,
  type AppIdentity,
  type LoadedAvatar,
} from './identity.js';

export { resolveOwnerIdentity, type OwnerIdentity, type ResolveOwnerOptions } from './owner.js';
export { verifyLarkBot, consoleLinks, scopeDeepLink, type VerifyOptions, type VerifyReport, type VerifyCheck } from './verify.js';
export { writeCredentialsFile, readCredentialsFile, updateEnvFile, type StoredCredentials } from './output.js';
export { validateCredentials, type CredentialValidation } from './validate.js';
export { safeErrorMessage, redactSecrets } from './util.js';

export {
  presets,
  composePresets,
  classifyEventNames,
  toScopeManifest,
  isPresetName,
  PRESET_NAMES,
  DEFAULT_PRESETS,
  DEFAULT_MANIFEST,
  DEFAULT_SCOPE_MANIFEST,
  FULL_SCOPE_MANIFEST,
  FULL_TENANT_SCOPES,
  FULL_USER_SCOPES,
  AUTO_REJECTED_SCOPES,
  DEFAULT_EVENTS,
  DEFAULT_CALLBACKS,
  DEFAULT_USER_SCOPES,
  MESSAGING_CORE_TENANT_SCOPES,
  BOT_MESSAGING_TENANT_SCOPES,
  CONTACT_TENANT_SCOPES,
  APP_SELF_MANAGE_SCOPES,
  VC_MEETING_TENANT_SCOPES,
  BOT_BASELINE_EVENTS,
  BOT_OPTIONAL_EVENTS,
  VC_MEETING_BOT_EVENTS,
  VC_MEETING_APP_EVENTS,
  VC_MEETING_USER_EVENTS,
  DOC_COMMENT_EVENT,
  CARD_ACTION_CALLBACK,
  type ScopeManifest,
  type BotPreset,
  type BotManifest,
  type PresetName,
} from './presets.js';
