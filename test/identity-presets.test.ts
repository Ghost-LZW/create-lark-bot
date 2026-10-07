import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  applyUserPlaceholder,
  crc32,
  defaultAppIcon,
  loadAvatar,
  pickAvailableName,
  validateAvatarPng,
} from '../src/identity.js';
import {
  AUTO_REJECTED_SCOPES,
  classifyEventNames,
  composePresets,
  DEFAULT_CALLBACKS,
  DEFAULT_SCOPE_MANIFEST,
  FULL_TENANT_SCOPES,
  FULL_USER_SCOPES,
  presets,
  PRESET_NAMES,
} from '../src/presets.js';
import { redactSecrets, safeErrorMessage } from '../src/util.js';

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe('identity', () => {
  it('generates a valid neutral 512×512 default icon', () => {
    const icon = defaultAppIcon();
    expect(validateAvatarPng(icon)).toEqual({ ok: true });
    expect(icon.readUInt32BE(16)).toBe(512);
    expect(defaultAppIcon().equals(icon)).toBe(true); // deterministic
  });

  it('validates PNG type, IHDR CRC, size and dimensions', () => {
    expect(validateAvatarPng(png(512, 512)).ok).toBe(true);
    expect(validateAvatarPng(png(256, 256))).toMatchObject({ ok: false, message: expect.stringMatching(/512×512/) });
    expect(validateAvatarPng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(0)]))).toMatchObject({ ok: false, message: expect.stringMatching(/PNG/) });
    const bad = png(512, 512); bad[29] ^= 0xff; // corrupt IHDR CRC
    expect(validateAvatarPng(bad)).toMatchObject({ ok: false, message: expect.stringMatching(/CRC/) });
    const huge = Buffer.concat([png(512, 512), Buffer.alloc(2 * 1024 * 1024)]);
    expect(validateAvatarPng(huge)).toMatchObject({ ok: false, message: expect.stringMatching(/过大/) });
  });

  it('loads avatars from file, URL (download) and rejects bad input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'create-lark-bot-'));
    const file = join(dir, 'a.png');
    writeFileSync(file, png(512, 512));
    expect((await loadAvatar(file)).source).toBe('file');
    await expect(loadAvatar(join(dir, 'missing.png'))).rejects.toThrow(/找不到/);

    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).endsWith('/ok.png')) return new Response(png(512, 512), { status: 200 });
      if (String(url).endsWith('/big.png')) return new Response('x', { status: 200, headers: { 'content-length': String(5 * 1024 * 1024) } });
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    const fromUrl = await loadAvatar('https://img.example/ok.png', { fetchImpl });
    expect(fromUrl).toMatchObject({ source: 'url', url: 'https://img.example/ok.png' });
    await expect(loadAvatar('https://img.example/big.png', { fetchImpl })).rejects.toThrow(/过大/);
    await expect(loadAvatar('https://img.example/404.png', { fetchImpl })).rejects.toThrow(/HTTP 404/);
    expect((await loadAvatar(undefined)).source).toBe('default');
  });

  it('applies {user} and picks a free default name', () => {
    expect(applyUserPlaceholder("{user}'s bot", 'Alice')).toBe("Alice's bot");
    expect(applyUserPlaceholder('{user} bot', undefined)).toBe('{user} bot');
    expect(pickAvailableName('lark-bot', [])).toBe('lark-bot');
    expect(pickAvailableName('lark-bot', ['Lark-Bot', 'lark-bot-2'])).toBe('lark-bot-3');
  });
});

describe('presets', () => {
  const allTenant = new Set(FULL_TENANT_SCOPES);
  const allUser = new Set(FULL_USER_SCOPES);

  it('every preset scope exists in the refreshed full manifest (no typos)', () => {
    for (const name of PRESET_NAMES) {
      const m = composePresets(name);
      for (const s of m.scopes.tenant) expect(allTenant.has(s), `${name}: tenant ${s}`).toBe(true);
      for (const s of m.scopes.user) expect(allUser.has(s), `${name}: user ${s}`).toBe(true);
    }
  });

  it('never requests auto-rejected scopes (they make publish review reject the whole app)', () => {
    for (const s of AUTO_REJECTED_SCOPES) {
      expect(allTenant.has(s)).toBe(false);
      expect(allUser.has(s)).toBe(false);
    }
    expect(allTenant.has('im:message')).toBe(true); // negative control
    expect(allUser.has('im:feed_group_v1:write')).toBe(true);
    expect(allTenant.has('base:app:create')).toBe(true); // botmux #1506
  });

  it('messagingCore covers the minimal receive/reply bot', () => {
    const m = composePresets('messagingCore');
    expect(m.scopes.tenant).toEqual(['im:message:send_as_bot', 'im:message', 'im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly']);
    expect(m.events.app).toEqual(['im.message.receive_v1']);
    expect(m.callbacks).toEqual(['card.action.trigger']);
    const full = composePresets('messaging');
    expect(full.scopes.tenant).toEqual(expect.arrayContaining(['im:message.group_msg', 'im:resource', ...m.scopes.tenant]));
  });

  it('composes names and inline extras, de-duplicated', () => {
    const m = composePresets('messagingCore', 'contact', { scopes: { tenant: ['im:message', 'docx:document:readonly'] }, events: { app: ['x.y_v1'] }, callbacks: ['card.action.trigger'] });
    expect(m.scopes.tenant.filter(s => s === 'im:message')).toHaveLength(1);
    expect(m.scopes.tenant).toContain('contact:user.base:readonly');
    expect(m.scopes.tenant).toContain('docx:document:readonly');
    expect(m.events.app).toEqual(['im.message.receive_v1', 'x.y_v1']);
    expect(m.callbacks).toEqual(['card.action.trigger']);
    expect(() => composePresets('nope' as any)).toThrow(/Unknown preset/);
  });

  it('vcMeeting puts the participant event in the user bucket', () => {
    const m = composePresets(presets.vcMeeting);
    expect(m.events.user).toEqual(['vc.meeting.participant_meeting_joined_v1']);
    expect(m.events.app).not.toContain('vc.meeting.participant_meeting_joined_v1');
  });

  it('default manifest keeps 0.1.x content plus owner-resolution contact scopes; callbacks split out', () => {
    expect(DEFAULT_SCOPE_MANIFEST.scopes?.tenant).toEqual(expect.arrayContaining(['vc:meeting.bot.join:write', 'contact:user.base:readonly', 'contact:user.id:readonly', 'application:application:self_manage']));
    expect(DEFAULT_CALLBACKS).toEqual(['card.action.trigger']);
    expect(classifyEventNames(['im.message.receive_v1', 'card.action.trigger', 'vc.meeting.participant_meeting_joined_v1'])).toEqual({
      app: ['im.message.receive_v1'], user: ['vc.meeting.participant_meeting_joined_v1'], callbacks: ['card.action.trigger'],
    });
  });
});

describe('secret redaction', () => {
  it('masks explicit secrets and long tokens, follows the cause chain', () => {
    expect(redactSecrets('secret=abcd1234 ok', ['abcd1234'])).toBe('secret=*** ok');
    const err = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' }) });
    expect(safeErrorMessage(err)).toBe('fetch failed: connect ECONNRESET');
    expect(safeErrorMessage(new Error('token: ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'))).toBe('token: ***');
  });
});
