# Changelog

## 0.2.3

### Changed

- `update` no longer writes `./lark-app.json` by default; it writes credentials only with `--out` / `--write-env`. `create` keeps the default.

## 0.2.2

### Added

- `--qr-out <file>`: also write the QR contents (web login payload or device-flow URL) to a 0600 file, for environments that cannot show a terminal QR code.

## 0.2.1

### Fixed

- Installing from git (`npx github:Ghost-LZW/create-lark-bot`) now builds `dist/` via a `prepare` script; 0.2.0 installed without its CLI.

## 0.2.0

### Added
- **One-scan console flow (default for feishu)**: one Feishu Web session (zero scans with a cached
  session) creates the app via the Open Platform console with your identity, reads AppID/AppSecret
  (read-only), configures it and publishes. Ported from botmux `createFeishuOpenPlatformApp` /
  `createOpenPlatformAppWithClient` / `automateOpenPlatformSetup`.
- **Custom identity**: `identity: { name, description, avatar }` and CLI `--name` / `--desc` /
  `--avatar <file|url>`. `{user}` placeholder. Avatar upload via the console icon endpoint
  (512×512 PNG ≤ 2 MB, validated before anything is created); URL avatars are downloaded and
  validated; neutral generated default icon; default name `lark-bot` (`-2`, `-3`… when taken).
- **SDK compat path** with `@larksuiteoapi/node-sdk` ≥ 1.74 `appPreset` (name/desc/avatar URLs) and
  `addons` (scopes/events/callbacks/preset), `appId` (update existing app) and `createOnly`.
  Used for Lark tenants, `--compat`, and as automatic fallback when the console path fails before
  creating anything.
- **Existing apps**: `selectExistingApp` (list + pick + read secret, session-expiry re-scan),
  `updateOpenPlatformAppIdentity` (fail-closed base_info write + republish), `updateLarkBot`,
  CLI `update --app-id | --select`.
- **Composable presets**: `presets.messagingCore`, `messaging`, `contact`, `selfManage`,
  `vcMeeting`, `userLogin`, `docs`, `wiki`, `sheets`, `base`, `calendar`, `tasks`, `urgent`,
  `chatTabs`, `feedGroups`, `full`; `composePresets()`; full manifest refreshed from botmux
  `lark-scopes.json` (tenant 170 / user 129).
- **Owner resolution** through the new app (`resolveOwnerIdentity`): open_id or session email →
  union_id via the contact API; reports which ids are verified, never trusts an unverified open_id.
- **`verify`** (API + CLI) using official APIs only: tenant token, `bot/v3/info`, application v6
  scope readback (honest `unknown` when not permitted), optional WebSocket probe, console deep
  links, batch-import scope JSON.
- **Outputs**: `--write-env` (in-place `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_DOMAIN`, 0600),
  `--env-owner-var`, `--json` (no secret), credentials file dir 0700.
- Console configuration now also: narrows required privilege data ranges, enables bot capability
  and long-connection mode, subscribes callbacks (`card.action.trigger`), merges (never overwrites)
  the redirect whitelist, mirrors online visibility when publishing (+ additive `visibility`),
  commits stuck drafts, reads back commits, predicts approval, reports `app_under_review`
  (code 10046) and `session_expired`, skips publishing when nothing changed, drops auto-rejected scopes.
- Transient network retry for idempotent console calls; error messages follow the `cause` chain and
  mask long tokens.

### Changed (breaking)
- `createLarkBot()` default flow is now the console one-scan flow instead of SDK scan + Web scan.
  Pass `mode: 'sdk'` (CLI `--compat`) for the old device-flow creation. The result gained
  `source`, `identity`, `owner`, `warnings`, `sessionIdentity`; the failure `stage` may now be
  `'identity'` or `'create'` (and carries `appId` when the app already exists).
- `DEFAULT_EVENTS` no longer contains `card.action.trigger` (it is a callback): use
  `DEFAULT_CALLBACKS`. A `card.action.trigger` passed in `events` is routed to callbacks automatically.
- Event subscription uses the console's real incremental contract (`operation:'add'`, app/user
  buckets, read-back); the 0.1.x `eventNames` bodies / `event_callback` endpoint did not exist.
- Publishing mirrors `visible/online` instead of `contact_range` members; `buildAppVersionCreatePayload`
  no longer sends `applyReasonConfig`/`autoPublish`/`remark` (they forced manual review);
  `nextAppVersion` considers drafts too.
- `ConfigureAppResult` gained fields; new failure reasons: `session_expired`,
  `owner_session_mismatch`, `event_verification_failed`, `visibility_unreadable`, `app_under_review`.
- `buildEventSubscriptionPayload(appId, eventMode, appEvents, userEvents)` signature changed.
- `DEFAULT_SCOPE_MANIFEST` scopes are unchanged (all verified against the refreshed manifest);
  `DEFAULT_EVENTS` gained `im.chat.member.bot.deleted_v1`, `im.chat.member.user.added_v1`,
  `im.chat.member.user.deleted_v1`, `im.message.updated_v1` (botmux's current baseline/optional events).
- Requires `@larksuiteoapi/node-sdk` ^1.74.0.
