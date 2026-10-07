/**
 * configureOpenPlatformApp against a fake console (no network).
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureOpenPlatformApp, resolveRequestedManifest } from '../src/open-platform.js';
import { cachedSessionFile, fakeConsole, json } from './helpers/fake-console.js';

const catalog = [
  { id: 't-msg', name: 'im:message', bucket: 'app' as const },
  { id: 'u-msg', name: 'im:message', bucket: 'user' as const },
];
const base = (extra: Record<string, unknown> = {}) => ({
  appId: 'cli_x',
  sessionFilePath: cachedSessionFile(),
  scopeManifest: { scopes: { tenant: ['im:message'], user: ['im:message'] } },
  onStatus: () => {},
  ...extra,
});

describe('configureOpenPlatformApp', () => {
  it('rejects lark brand with unsupported_brand', async () => {
    expect(await configureOpenPlatformApp({ appId: 'cli_x', brand: 'lark' })).toMatchObject({ ok: false, reason: 'unsupported_brand' });
  });

  it('returns login failure without throwing', async () => {
    const result = await configureOpenPlatformApp({
      appId: 'cli_x',
      sessionFilePath: join(tmpdir(), `create-lark-bot-missing-${Date.now()}.json`),
      fetchImpl: (async () => { throw new Error('login down'); }) as typeof fetch,
      onQrCode: () => {},
      maxWaitMs: 1,
    });
    expect(result).toMatchObject({ ok: false, reason: 'login_failed' });
  });

  it('runs the full chain on a just-created app: scopes, switches, events by bucket, callbacks, redirect, publish', async () => {
    const fc = fakeConsole({ scopeCatalog: catalog, initialEvents: { eventMode: 0 }, initialCallbacks: { callbackMode: 0 } });
    const result = await configureOpenPlatformApp(base({
      fetchImpl: fc.fetchImpl,
      events: ['im.message.receive_v1', 'vc.meeting.participant_meeting_joined_v1', 'card.action.trigger'],
      redirectUrls: ['http://127.0.0.1:9000/callback'],
      appJustCreated: true,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessionSource).toBe('cache');
    expect(result.redirectConfigured).toBe(true);
    expect(result.versionId).toBe('v_1');
    expect(result.versionWarning).toBeUndefined();
    expect(result.eventModeReady).toBe(true);

    // csrf + cookie headers on writes
    const scopeUpdate = fc.find('/scope/update/')!;
    expect(scopeUpdate.headers.get('x-csrf-token')).toBe('csrf_fake');
    expect(scopeUpdate.headers.get('cookie')).toBe('session=secret-cookie-value');
    expect(scopeUpdate.body).toMatchObject({ appScopeIDs: ['t-msg'], userScopeIDs: ['u-msg'], operation: 'add' });

    // incremental console event contract, user events in their own bucket, callback separate
    const eventUpdate = fc.find('/event/update/')!;
    expect(eventUpdate.body).toEqual({
      clientId: 'cli_x',
      operation: 'add',
      events: [],
      appEvents: ['im.message.receive_v1'],
      userEvents: ['vc.meeting.participant_meeting_joined_v1'],
      eventMode: 4,
    });
    expect(fc.find('/callback/switch/')!.body).toMatchObject({ callbackMode: 4 });
    expect(fc.find('/callback/update/')!.body).toMatchObject({ operation: 'add', callbacks: ['card.action.trigger'] });
    expect(fc.find('/robot/switch/')!.body).toMatchObject({ enable: true });

    // redirect: read first, then a merged write
    expect(fc.paths().indexOf('/developers/v1/safe_setting/cli_x')).toBeLessThan(fc.paths().indexOf('/developers/v1/safe_setting/update/cli_x'));
    expect(fc.find('/safe_setting/update/')!.body).toEqual({ clientId: 'cli_x', redirectURL: ['http://127.0.0.1:9000/callback'] });

    // publish mirrors visible/online (never contact_range)
    const create = fc.find('/app_version/create/')!;
    expect(create.body).toMatchObject({ visibleSuggest: { members: ['ou_member'], isAll: 0 } });
    expect(fc.paths()).not.toContain('/developers/v1/contact_range/cli_x');
    expect(fc.paths()).toContain('/developers/v1/publish/commit/cli_x/v_1');
  });

  it('keeps existing redirect URLs (merge, never overwrite)', async () => {
    const fc = fakeConsole({
      scopeCatalog: catalog,
      safeSetting: { allowRefreshToken: true, ipWhiteList: [], safeServerDomain: [], redirectURL: ['https://user.example/cb'] },
    });
    const result = await configureOpenPlatformApp(base({ fetchImpl: fc.fetchImpl, redirectUrls: ['http://127.0.0.1:9000/callback'] }));
    expect(result.ok).toBe(true);
    expect(fc.find('/safe_setting/update/')!.body).toMatchObject({ redirectURL: ['https://user.example/cb', 'http://127.0.0.1:9000/callback'] });
  });

  it('does not blind-write an unreadable redirect whitelist on an existing app', async () => {
    const fc = fakeConsole({ scopeCatalog: catalog, prefixHandlers: { '/safe_setting/cli_x': () => json({ code: 0, data: {} }) } });
    const result = await configureOpenPlatformApp(base({ fetchImpl: fc.fetchImpl, redirectUrls: ['http://127.0.0.1:9000/callback'] }));
    expect(result.ok && result.redirectConfigured).toBe(false);
    expect(fc.find('/safe_setting/update/')).toBeUndefined();
  });

  it('skips publishing when nothing changed (existing, fully-configured app)', async () => {
    const wanted = resolveRequestedManifest({ events: ['im.message.receive_v1'] });
    const fc = fakeConsole({
      scopeCatalog: [],
      initialEvents: { app: wanted.events.app, user: wanted.events.user },
      initialCallbacks: { callbacks: wanted.callbacks },
    });
    const result = await configureOpenPlatformApp(base({ fetchImpl: fc.fetchImpl, events: ['im.message.receive_v1'] }));
    expect(result).toMatchObject({ ok: true, publishSkipped: true, scopeCount: 0 });
    expect(fc.find('/app_version/create/')).toBeUndefined();
    expect(fc.find('/publish/commit/')).toBeUndefined();
  });

  it('commits an uncommitted draft instead of creating a version (code=10043 deadlock)', async () => {
    const fc = fakeConsole({ scopeCatalog: catalog, versions: [{ versionId: 'v_draft', appVersion: '1.0.1', versionStatus: 0 }] });
    const result = await configureOpenPlatformApp(base({ fetchImpl: fc.fetchImpl }));
    expect(result).toMatchObject({ ok: true, versionId: 'v_draft', versionReused: true });
    expect(fc.find('/app_version/create/')).toBeUndefined();
  });

  it('warns when commit returns ok but the version is still a draft', async () => {
    const fc = fakeConsole({ scopeCatalog: catalog, prefixHandlers: { '/publish/commit/': () => json({ code: 0 }) } });
    const result = await configureOpenPlatformApp(base({ fetchImpl: fc.fetchImpl }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.versionWarning).toMatch(/草稿/);
  });

  it('reports approval prediction (auto-approved vs human approvers)', async () => {
    const fc = fakeConsole({
      scopeCatalog: catalog,
      prefixHandlers: {
        '/approval_nodes/get/': () => json({
          code: 0,
          data: { applyInstanceInfo: { applyNodes: [
            { nodeName: '发起' },
            { nodeName: '管理员审批', nodeType: '人工审批', nodeUser: [{ approver: { name: 'Bob' } }] },
            { nodeName: '结束' },
          ] } },
        }),
      },
    });
    const result = await configureOpenPlatformApp(base({ fetchImpl: fc.fetchImpl }));
    expect(result).toMatchObject({ ok: true, approvalAutoPassed: false, approvalHumanApprovers: ['Bob'] });
  });

  it('maps code=10046 to app_under_review with the in-review version id, and never withdraws it', async () => {
    const fc = fakeConsole({
      scopeCatalog: catalog,
      versions: [{ versionId: 'v_review', appVersion: '1.0.2', versionStatus: 1 }],
      prefixHandlers: { '/robot/switch/': () => json({ code: 10046, msg: '审核中, 请刷新' }) },
    });
    const result = await configureOpenPlatformApp(base({ fetchImpl: fc.fetchImpl }));
    expect(result).toMatchObject({ ok: false, reason: 'app_under_review', inReviewVersionId: 'v_review' });
    expect(fc.find('/cancel_commit/')).toBeUndefined();
  });

  it('signals session_expired (re-scan needed) on a console logout response', async () => {
    const fc = fakeConsole({
      prefixHandlers: {
        '/scope/all/': () => json({ code: 99991641, msg: 'error', error: { Code: 4101, LogoutReason: 40, message: 'please log in again' } }, { status: 400 }),
      },
    });
    const result = await configureOpenPlatformApp(base({ fetchImpl: fc.fetchImpl }));
    expect(result).toMatchObject({ ok: false, reason: 'session_expired' });
  });

  it('fails closed when the critical receive event cannot be confirmed', async () => {
    const fc = fakeConsole({ scopeCatalog: catalog, prefixHandlers: { '/event/update/': () => json({ code: 1, msg: 'nope' }) } });
    const result = await configureOpenPlatformApp(base({ fetchImpl: fc.fetchImpl, events: ['im.message.receive_v1'] }));
    expect(result).toMatchObject({ ok: false, reason: 'event_verification_failed' });
    expect(fc.find('/app_version/create/')).toBeUndefined();
  });

  it('refuses to publish when online visibility cannot be parsed', async () => {
    const fc = fakeConsole({ scopeCatalog: catalog, visibleOnline: { code: 0, data: { whiteList: {} } } });
    const result = await configureOpenPlatformApp(base({ fetchImpl: fc.fetchImpl }));
    expect(result).toMatchObject({ ok: false, reason: 'visibility_unreadable' });
    expect(fc.find('/app_version/create/')).toBeUndefined();
  });

  it('applies additive visibility (never narrows) and publishes even without other changes', async () => {
    const wanted = resolveRequestedManifest({ events: ['im.message.receive_v1'] });
    const fc = fakeConsole({ initialEvents: { app: wanted.events.app }, initialCallbacks: { callbacks: wanted.callbacks } });
    const result = await configureOpenPlatformApp(base({ fetchImpl: fc.fetchImpl, events: ['im.message.receive_v1'], visibility: { members: ['ou_new'] } }));
    expect(result.ok).toBe(true);
    expect(fc.find('/app_version/create/')!.body).toMatchObject({ visibleSuggest: { members: ['ou_member', 'ou_new'] } });
  });

  it('treats a rejected scope batch as a warning and still publishes', async () => {
    const fc = fakeConsole({ scopeCatalog: catalog, prefixHandlers: { '/scope/update/': () => json({ code: 1, msg: 'scope not grantable' }) } });
    const result = await configureOpenPlatformApp(base({ fetchImpl: fc.fetchImpl }));
    expect(result).toMatchObject({ ok: true, scopeCount: 0 });
    if (result.ok) expect(result.scopeWarning).toBeTruthy();
  });

  it('drops auto-rejected scopes from a custom manifest', async () => {
    const fc = fakeConsole({ scopeCatalog: [...catalog, { id: 'bad', name: 'im:special_focus', bucket: 'app' }] });
    const result = await configureOpenPlatformApp(base({
      fetchImpl: fc.fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message', 'im:special_focus'], user: [] } },
    }));
    expect(result.ok && result.droppedScopes).toEqual(['im:special_focus']);
    expect(fc.find('/scope/update/')!.body).toMatchObject({ appScopeIDs: ['t-msg'] });
  });

  it('narrows required privilege data ranges to "same as app availability"', async () => {
    const privilege = {
      bizId: 'vc', resource: 'meeting', name: '会议信息', isRequired: true, content: '{"mode":"all"}',
      schemaType: 1, organizationType: 1,
      schemaContent: { selectionExpressionSchemaContent: { fields: [{ id: 'member_range', name: '成员', data_source: { type: 'select_staff' }, operators: ['in'] }] } },
    };
    const fc = fakeConsole({
      scopeCatalog: catalog,
      prefixHandlers: { '/privilege/all/': () => json({ code: 0, data: { privileges: [privilege], scopeBiz: [{ bizId: 'vc', bizName: '视频会议' }] } }) },
    });
    const result = await configureOpenPlatformApp(base({ fetchImpl: fc.fetchImpl }));
    expect(result).toMatchObject({ ok: true, privilegeRangeCount: 1 });
    const update = fc.find('/privilege/update/')!.body as any;
    expect(JSON.parse(update.privileges[0].content)).toMatchObject({ mode: 'part', biz_id: 'vc' });
  });

  it('uses the redirected console origin for API calls and referer', async () => {
    const fc = fakeConsole({
      scopeCatalog: catalog,
      handlers: {
        '/app/cli_x/auth': c => (c.url.startsWith('https://open.feishu.cn')
          ? new Response('', { status: 302, headers: { location: 'https://open.larkoffice.com/app/cli_x/auth' } })
          : undefined),
      },
    });
    const result = await configureOpenPlatformApp(base({ fetchImpl: fc.fetchImpl }));
    expect(result.ok).toBe(true);
    const update = fc.find('/scope/update/')!;
    expect(update.url).toBe('https://open.larkoffice.com/developers/v1/scope/update/cli_x');
    expect(update.headers.get('referer')).toBe('https://open.larkoffice.com/app/cli_x');
  });
});
