/**
 * Verify a bot app with OFFICIAL Open APIs only (no console session needed):
 *  - credentials: `POST /open-apis/auth/v3/tenant_access_token/internal`
 *  - bot capability: `GET /open-apis/bot/v3/info`
 *  - granted scopes: `GET /open-apis/application/v6/applications/{app_id}` (needs
 *    `application:application:self_manage`; reported as `unknown` when not permitted)
 *  - events/callbacks: no official API lists them → always `unknown` + console deep link
 *  - optional live probe: start the SDK `WSClient` and poll `getConnectionStatus()`
 *
 * `unknown` is never counted as pass or fail. Secrets never appear in the report.
 */
import { Domain, EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';
import { composePresets, toScopeManifest, type BotManifest, type BotPreset, type PresetName, type ScopeManifest } from './presets.js';
import type { RegisterBrand } from './register-app.js';
import { asRecord, redactSecrets } from './util.js';
import { openApiOrigin } from './validate.js';

export type CheckStatus = 'ok' | 'fail' | 'unknown' | 'skipped';

export interface VerifyCheck {
  id: 'credentials' | 'bot' | 'scopes' | 'events' | 'ws';
  status: CheckStatus;
  detail: string;
  link?: string;
}

export interface ConsoleLinks {
  home: string;
  scopes: string;
  events: string;
  versions: string;
}

export function consoleLinks(appId: string, brand: RegisterBrand = 'feishu'): ConsoleLinks {
  const home = `${openApiOrigin(brand)}/app/${appId}`;
  return { home, scopes: `${home}/auth`, events: `${home}/dev-config/event-sub`, versions: `${home}/version` };
}

/** Deep link that opens the scope page filtered to one scope. */
export function scopeDeepLink(appId: string, scope: string, brand: RegisterBrand = 'feishu'): string {
  return `${openApiOrigin(brand)}/app/${appId}/auth?q=${encodeURIComponent(scope)}&op_from=openapi&token_type=tenant`;
}

export interface VerifyReport {
  appId: string;
  brand: RegisterBrand;
  /** False when any check failed. `unknown` never counts as pass or fail. */
  ok: boolean;
  checks: VerifyCheck[];
  /** Requested scopes not found among the granted ones (empty when the readback was unknown). */
  missingScopes: { name: string; required: boolean; link: string }[];
  /** Granted scope names, when readable. */
  grantedScopes?: string[];
  /** Paste into the console's "batch import scopes" box. */
  scopesJson: ScopeManifest;
  links: ConsoleLinks;
}

/** Minimal WS surface (lets tests inject a fake). */
export interface WsProbeClient {
  start(params: { eventDispatcher: unknown }): Promise<void> | void;
  getConnectionStatus?(): { state: string };
  close(params?: { force?: boolean }): void;
}

export interface VerifyOptions {
  appId: string;
  appSecret: string;
  brand?: RegisterBrand;
  /** What the bot should have. Default: the default presets. */
  presets?: Array<PresetName | BotPreset>;
  /** Scopes whose absence is a failure (others are reported but only warn). Default: messagingCore tenant scopes. */
  requiredScopes?: string[];
  /** Also start a WebSocket client and wait until it connects. */
  live?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Test seam for the live probe. */
  createWsClient?: (params: { appId: string; appSecret: string; brand: RegisterBrand }) => WsProbeClient;
}

const NO_PERMISSION = 99991672;

export async function verifyLarkBot(options: VerifyOptions): Promise<VerifyReport> {
  const brand = options.brand ?? 'feishu';
  const origin = openApiOrigin(brand);
  const links = consoleLinks(options.appId, brand);
  const fetcher = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const manifest: BotManifest = options.presets ? composePresets(...options.presets) : composePresets('messaging', 'contact', 'selfManage', 'vcMeeting', 'userLogin');
  const required = new Set(options.requiredScopes ?? composePresets('messagingCore').scopes.tenant);
  const scrub = (text: string) => redactSecrets(text, [options.appSecret]);
  const checks: VerifyCheck[] = [];
  let missingScopes: VerifyReport['missingScopes'] = [];
  let grantedScopes: string[] | undefined;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let token: string | undefined;
    try {
      const res = await fetcher(`${origin}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: options.appId, app_secret: options.appSecret }),
        signal: ac.signal,
      });
      const body = asRecord(await res.json());
      if (body.code === 0 && typeof body.tenant_access_token === 'string') {
        token = body.tenant_access_token;
        checks.push({ id: 'credentials', status: 'ok', detail: 'tenant_access_token obtained' });
      } else {
        checks.push({ id: 'credentials', status: 'fail', detail: scrub(`tenant token refused (code ${String(body.code ?? res.status)}): ${String(body.msg ?? '')}`.trim()) });
      }
    } catch (err) {
      checks.push({ id: 'credentials', status: 'unknown', detail: scrub(`could not reach the platform: ${err instanceof Error ? err.message : String(err)}`) });
    }

    if (token) {
      const auth = { Authorization: `Bearer ${token}` };
      try {
        const body = asRecord(await (await fetcher(`${origin}/open-apis/bot/v3/info`, { headers: auth, signal: ac.signal })).json());
        const bot = asRecord(body.bot ?? asRecord(body.data).bot);
        if (body.code === 0 && typeof bot.open_id === 'string') {
          checks.push({ id: 'bot', status: 'ok', detail: `bot capability is on${typeof bot.app_name === 'string' ? ` (${bot.app_name})` : ''}` });
        } else {
          checks.push({ id: 'bot', status: 'fail', detail: `bot info unavailable (code ${String(body.code ?? '?')}): enable the Bot capability and publish a version`, link: links.home });
        }
      } catch (err) {
        checks.push({ id: 'bot', status: 'unknown', detail: scrub(`bot info request failed: ${err instanceof Error ? err.message : String(err)}`) });
      }

      try {
        const body = asRecord(await (await fetcher(`${origin}/open-apis/application/v6/applications/${options.appId}?lang=zh_cn`, { headers: auth, signal: ac.signal })).json());
        if (body.code === NO_PERMISSION) {
          checks.push({ id: 'scopes', status: 'unknown', detail: 'cannot read granted scopes: the app lacks application:application:self_manage (or it is not published yet); check by hand', link: links.scopes });
        } else if (body.code !== 0) {
          checks.push({ id: 'scopes', status: 'unknown', detail: `scope readback failed (code ${String(body.code ?? '?')}): ${String(body.msg ?? '')}`.trim(), link: links.scopes });
        } else {
          const data = asRecord(body.data);
          const raw = asRecord(data.app).scopes ?? asRecord(data.application).scopes ?? data.scopes ?? [];
          const names = (Array.isArray(raw) ? raw : [])
            .map(s => (typeof s === 'string' ? s : asRecord(s).scope ?? asRecord(s).scope_name))
            .filter((s): s is string => typeof s === 'string' && s.length > 0);
          grantedScopes = [...new Set(names)];
          if (grantedScopes.length === 0) {
            checks.push({ id: 'scopes', status: 'unknown', detail: 'scope readback returned no scopes; cannot tell what is granted', link: links.scopes });
          } else {
            // The readback is a flat name list (no tenant/user split): we compare tenant scopes only.
            const have = new Set(grantedScopes);
            missingScopes = manifest.scopes.tenant
              .filter(name => !have.has(name))
              .map(name => ({ name, required: required.has(name), link: scopeDeepLink(options.appId, name, brand) }));
            const blocking = missingScopes.filter(s => s.required);
            checks.push({
              id: 'scopes',
              status: blocking.length ? 'fail' : 'ok',
              detail: missingScopes.length
                ? `missing ${missingScopes.length}: ${missingScopes.map(s => `${s.name}${s.required ? ' [required]' : ''}`).join(', ')}`
                : 'all requested tenant scopes are granted',
              ...(missingScopes.length ? { link: links.scopes } : {}),
            });
          }
        }
      } catch (err) {
        checks.push({ id: 'scopes', status: 'unknown', detail: scrub(`scope readback failed: ${err instanceof Error ? err.message : String(err)}`), link: links.scopes });
      }
    }
  } finally {
    clearTimeout(timer);
  }

  const wantedEvents = [...manifest.events.app, ...manifest.events.user, ...manifest.callbacks];
  checks.push({
    id: 'events',
    status: 'unknown',
    detail: `no official API lists event subscriptions; confirm in the console: ${wantedEvents.join(', ') || '(none requested)'} (or run with live and send the bot a message)`,
    link: links.events,
  });

  if (options.live) checks.push(await probeWs(options, brand, timeoutMs, links, scrub));
  else checks.push({ id: 'ws', status: 'skipped', detail: 'run with live=true / --live to probe the WebSocket connection' });

  return {
    appId: options.appId,
    brand,
    ok: !checks.some(c => c.status === 'fail'),
    checks,
    missingScopes,
    ...(grantedScopes ? { grantedScopes } : {}),
    scopesJson: toScopeManifest(manifest),
    links,
  };
}

async function probeWs(
  options: VerifyOptions,
  brand: RegisterBrand,
  timeoutMs: number,
  links: ConsoleLinks,
  scrub: (text: string) => string,
): Promise<VerifyCheck> {
  const params = { appId: options.appId, appSecret: options.appSecret, brand };
  const ws: WsProbeClient = options.createWsClient
    ? options.createWsClient(params)
    : (new WSClient({
        appId: params.appId,
        appSecret: params.appSecret,
        domain: brand === 'lark' ? Domain.Lark : Domain.Feishu,
        autoReconnect: false,
        loggerLevel: LoggerLevel.error,
      }) as unknown as WsProbeClient);
  try {
    await ws.start({ eventDispatcher: new EventDispatcher({}) });
    if (!ws.getConnectionStatus) return { id: 'ws', status: 'unknown', detail: 'WS started but this client cannot report its state' };
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = ws.getConnectionStatus().state;
      if (state === 'connected') return { id: 'ws', status: 'ok', detail: 'WebSocket connected' };
      if (state === 'failed') return { id: 'ws', status: 'fail', detail: 'WebSocket connection failed (long-connection mode on? app published?)', link: links.events };
      if (Date.now() >= deadline) return { id: 'ws', status: 'fail', detail: `no WebSocket connection within ${timeoutMs}ms (state: ${state})`, link: links.events };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (err) {
    return { id: 'ws', status: 'fail', detail: scrub(`WebSocket start failed: ${err instanceof Error ? err.message : String(err)}`) };
  } finally {
    try {
      ws.close({ force: true });
    } catch {
      /* already closed */
    }
  }
}
