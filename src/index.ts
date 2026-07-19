export {
  createLarkBot,
  type CreateLarkBotOptions,
  type CreateLarkBotResult,
} from './create-bot.js';

export {
  registerLarkApp,
  type RegisterAppOptions,
  type RegisterAppResult,
  type RegisterAppOk,
  type RegisterAppErr,
  type RegisterBrand,
} from './register-app.js';

export {
  configureOpenPlatformApp,
  createOpenPlatformApiClient,
  listOpenPlatformApps,
  fetchOpenPlatformAppSecret,
  buildScopeUpdatePayload,
  buildSafeSettingPayload,
  buildEventSubscriptionPayload,
  buildAppVersionCreatePayload,
  extractOpenPlatformCsrfToken,
  extractOpenPlatformScopeEntries,
  mapManifestScopesToOpenPlatformIds,
  nextAppVersion,
  extractVersionId,
  OpenPlatformApiError,
  type ConfigureAppOptions,
  type ConfigureAppResult,
  type OpenPlatformApiClient,
  type OpenPlatformAppSummary,
  type OpenPlatformScopeEntry,
  type MappedScopeIds,
} from './open-platform.js';

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

export { validateCredentials, type CredentialValidation } from './validate.js';

export {
  DEFAULT_SCOPE_MANIFEST,
  DEFAULT_EVENTS,
  DEFAULT_USER_SCOPES,
  BOT_MESSAGING_TENANT_SCOPES,
  CONTACT_TENANT_SCOPES,
  APP_SELF_MANAGE_SCOPES,
  VC_MEETING_TENANT_SCOPES,
  BOT_BASELINE_EVENTS,
  VC_MEETING_BOT_EVENTS,
  type ScopeManifest,
} from './presets.js';
