/**
 * "Select an existing app": Web session → list the self-built apps visible to the signed-in
 * account → pick one → read its AppSecret (read-only; never reset).
 *
 * Half-expired sessions must be recoverable (botmux d7d38532, #1392): the console `/app` page
 * can still render a csrf token while `/developers/v1/*` answers "please log in again". We
 * detect that with {@link openPlatformWebSessionExpired} (or a missing csrf token) and, when
 * the caller allows it, re-scan ONCE with `forceQrLogin`; otherwise we return
 * `reason: 'session_expired'` so the caller can ask the user and call again with
 * `forceQrLogin: true`.
 */
import {
  createOpenPlatformApiClient,
  openPlatformWebSessionExpired,
  type OpenPlatformApiClient,
  type WebSessionIdentity,
} from './console-client.js';
import { fetchOpenPlatformAppSecret, listOpenPlatformApps, type OpenPlatformAppSummary } from './create-app.js';
import { safeErrorMessage } from './util.js';
import { prepareWebSession, type WebSessionFailureReason, type WebSessionOptions, type WebSessionSource } from './web-session.js';

export type SelectExistingAppResult =
  | {
      ok: true;
      appId: string;
      appSecret: string;
      brand: 'feishu';
      app: OpenPlatformAppSummary;
      client: OpenPlatformApiClient;
      sessionIdentity?: WebSessionIdentity;
      sessionFile: string;
      sessionSource: WebSessionSource;
      /** A fresh QR login happened because the cached session had expired. */
      rescanned: boolean;
    }
  | {
      ok: false;
      reason:
        | WebSessionFailureReason
        /** Re-scan needed (and not allowed / already tried): call again with forceQrLogin. */
        | 'session_expired'
        | 'network'
        | 'no_apps'
        | 'not_found'
        | 'cancelled'
        | 'api_error';
      message: string;
      sessionFile?: string;
    };

export interface SelectExistingAppOptions extends WebSessionOptions {
  /** Pick this app directly (must be visible to the signed-in account). */
  appId?: string;
  /** Choose from the list; return the clientId, or null to cancel. */
  pick?: (apps: OpenPlatformAppSummary[], ctx: { identity?: WebSessionIdentity }) => string | null | Promise<string | null>;
  /**
   * What to do when the session turns out to be expired: `true` re-scans once automatically,
   * a function is asked first (e.g. a TTY prompt). Default false → `session_expired`.
   */
  allowRescan?: boolean | ((detail: string) => boolean | Promise<boolean>);
}

export async function selectExistingApp(options: SelectExistingAppOptions = {}): Promise<SelectExistingAppResult> {
  let forceQrLogin = options.forceQrLogin === true;
  let rescanned = false;
  const mayRescan = async (detail: string): Promise<boolean> => {
    if (forceQrLogin || rescanned) return false; // a fresh scan that is still "expired" is not a cookie problem
    if (options.disableQrLogin) return false;
    const allow = options.allowRescan;
    if (typeof allow === 'function') return Boolean(await allow(detail));
    return allow === true;
  };
  const expired = (detail: string, sessionFile?: string): SelectExistingAppResult => ({
    ok: false,
    reason: 'session_expired',
    message: `飞书开放平台登录态已失效，需要重新扫码（forceQrLogin）: ${detail}`,
    sessionFile,
  });

  for (;;) {
    const prepared = await prepareWebSession({ ...options, forceQrLogin });
    if (!prepared.ok) return { ok: false, reason: prepared.reason, message: prepared.message, sessionFile: prepared.sessionFile };
    if (forceQrLogin) rescanned = prepared.source === 'qr_login';

    const clientRes = await createOpenPlatformApiClient(prepared.cookies, { fetchImpl: options.fetchImpl });
    if (!clientRes.ok) {
      if (clientRes.reason === 'missing_csrf') {
        if (await mayRescan(clientRes.message)) { forceQrLogin = true; continue; }
        return expired(clientRes.message, prepared.sessionFile);
      }
      return { ok: false, reason: 'network', message: clientRes.message, sessionFile: prepared.sessionFile };
    }
    const { client, identity } = clientRes;

    let apps: OpenPlatformAppSummary[];
    try {
      apps = await listOpenPlatformApps(client);
    } catch (err) {
      if (openPlatformWebSessionExpired(err)) {
        if (await mayRescan(safeErrorMessage(err))) { forceQrLogin = true; continue; }
        return expired(safeErrorMessage(err), prepared.sessionFile);
      }
      return { ok: false, reason: 'api_error', message: `拉取应用列表失败: ${safeErrorMessage(err)}`, sessionFile: prepared.sessionFile };
    }

    let chosenId = options.appId;
    if (!chosenId) {
      if (apps.length === 0) return { ok: false, reason: 'no_apps', message: '当前账号名下没有可选的自建应用', sessionFile: prepared.sessionFile };
      if (!options.pick) return { ok: false, reason: 'cancelled', message: '没有指定 appId，也没有提供 pick 回调', sessionFile: prepared.sessionFile };
      chosenId = (await options.pick(apps, { identity })) ?? undefined;
      if (!chosenId) return { ok: false, reason: 'cancelled', message: '已取消选择', sessionFile: prepared.sessionFile };
    }
    const app = apps.find(a => a.clientId === chosenId);
    if (!app) {
      return { ok: false, reason: 'not_found', message: `当前账号可见的应用里没有 ${chosenId}（换个账号登录？）`, sessionFile: prepared.sessionFile };
    }

    try {
      const appSecret = await fetchOpenPlatformAppSecret(client, app.clientId);
      return {
        ok: true,
        appId: app.clientId,
        appSecret,
        brand: 'feishu',
        app,
        client,
        sessionIdentity: identity,
        sessionFile: prepared.sessionFile,
        sessionSource: prepared.source,
        rescanned,
      };
    } catch (err) {
      if (openPlatformWebSessionExpired(err)) {
        if (await mayRescan(safeErrorMessage(err))) { forceQrLogin = true; continue; }
        return expired(safeErrorMessage(err), prepared.sessionFile);
      }
      return { ok: false, reason: 'api_error', message: `读取 AppSecret 失败: ${safeErrorMessage(err)}`, sessionFile: prepared.sessionFile };
    }
  }
}
