/**
 * App identity: name, description and avatar — and the neutral defaults.
 *
 * Console path (feishu, the primary flow): the avatar must be uploaded to
 * `POST /developers/v1/app/upload/image` (multipart: file, uploadType=4 "Icon",
 * isIsv=false, scale={"width":512,"height":512}); the returned `url` goes into the
 * create / base_info payload. botmux has only ever verified 512×512 PNG for that upload
 * (its avatar validator rejects anything else), so we enforce the same: PNG, valid IHDR
 * (+CRC), exactly 512×512, ≤ 2 MB. A URL avatar is downloaded and validated the same way.
 *
 * SDK device-flow path: the avatar is passed as URL(s) in `appPreset.avatar` (the platform
 * page fetches it; png/jpg/jpeg/webp/gif, 1–6 URLs). A local file cannot be passed there.
 *
 * `{user}` placeholder: the SDK create page replaces it natively; on the console path we
 * replace it with the signed-in user's display name.
 */
import { readFileSync, statSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { safeErrorMessage } from './util.js';

export interface AppIdentity {
  /** App / bot name. Default {@link DEFAULT_APP_NAME} (with `-2`, `-3`… if taken). Supports `{user}`. */
  name?: string;
  /** App description. Default {@link DEFAULT_APP_DESCRIPTION}. Supports `{user}`. */
  description?: string;
  /**
   * Avatar: a local file path, an http(s) URL, or raw PNG bytes. Console path needs a
   * 512×512 PNG ≤ 2 MB. Omitted → a neutral generated icon (console) / platform default (SDK).
   */
  avatar?: string | Uint8Array;
}

export const DEFAULT_APP_NAME = 'lark-bot';
export const DEFAULT_APP_DESCRIPTION = 'A Feishu/Lark bot.';
export const AVATAR_IMAGE_SIZE = 512;
export const AVATAR_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** Platform limits for app names (console enforces ≤ 64 chars). */
export const APP_NAME_MAX_LENGTH = 64;

export function applyUserPlaceholder(text: string, userName: string | undefined): string {
  return userName ? text.split('{user}').join(userName) : text;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** `base`, else `base-2`, `base-3`… — the first one not in `taken` (case-insensitive). */
export function pickAvailableName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map(n => n.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; i < 10_000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export function validateAppName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return '应用名称不能为空';
  if ([...trimmed].length > APP_NAME_MAX_LENGTH) return `应用名称最长 ${APP_NAME_MAX_LENGTH} 个字符`;
  return null;
}

// ─── PNG validation (ported from botmux src/services/open-platform-rename.ts) ─────

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR_DATA_LENGTH = 13;
const PNG_MIN_HEADER_BYTES = 8 + 4 + 4 + PNG_IHDR_DATA_LENGTH + 4;

/** CRC-32 (IEEE, the PNG one). Implemented locally: node:zlib.crc32 needs Node ≥ 22.2. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function validateAvatarPng(input: Uint8Array): { ok: true } | { ok: false; message: string } {
  const data = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (data.length > AVATAR_IMAGE_MAX_BYTES) {
    return { ok: false, message: `头像图片过大（上限 ${AVATAR_IMAGE_MAX_BYTES / 1024 / 1024}MB）` };
  }
  if (data.length < PNG_MIN_HEADER_BYTES || !data.subarray(0, 8).equals(PNG_MAGIC)) {
    return { ok: false, message: '头像图片必须是 PNG 格式（开放平台控制台只验证过 512×512 PNG）' };
  }
  if (data.readUInt32BE(8) !== PNG_IHDR_DATA_LENGTH || data.subarray(12, 16).toString('latin1') !== 'IHDR') {
    return { ok: false, message: '头像图片必须是 PNG 格式（缺少合法的 IHDR 头）' };
  }
  if (data.readUInt32BE(12 + 4 + PNG_IHDR_DATA_LENGTH) !== crc32(data.subarray(12, 12 + 4 + PNG_IHDR_DATA_LENGTH))) {
    return { ok: false, message: '头像图片必须是 PNG 格式（IHDR CRC 校验失败）' };
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width !== AVATAR_IMAGE_SIZE || height !== AVATAR_IMAGE_SIZE) {
    return { ok: false, message: `头像图片必须是 ${AVATAR_IMAGE_SIZE}×${AVATAR_IMAGE_SIZE}（收到 ${width}×${height}）` };
  }
  return { ok: true };
}

/** Invalid name / description / avatar. Raised before anything is created. */
export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

export class AvatarError extends IdentityError {
  constructor(message: string) {
    super(message);
    this.name = 'AvatarError';
  }
}

export interface LoadedAvatar {
  bytes: Buffer;
  source: 'file' | 'url' | 'bytes' | 'default';
  /** The original URL when `source === 'url'`. */
  url?: string;
}

/**
 * Resolve an avatar spec to validated PNG bytes for the console upload.
 * Throws {@link AvatarError} with a printable message on any problem.
 */
export async function loadAvatar(
  avatar: string | Uint8Array | undefined,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<LoadedAvatar> {
  let loaded: LoadedAvatar;
  if (avatar === undefined) {
    return { bytes: defaultAppIcon(), source: 'default' };
  } else if (typeof avatar !== 'string') {
    loaded = { bytes: Buffer.from(avatar), source: 'bytes' };
  } else if (isHttpUrl(avatar)) {
    loaded = { bytes: await downloadAvatar(avatar.trim(), opts), source: 'url', url: avatar.trim() };
  } else {
    let size: number;
    try {
      size = statSync(avatar).size;
    } catch {
      throw new AvatarError(`找不到头像文件: ${avatar}`);
    }
    if (size > AVATAR_IMAGE_MAX_BYTES) throw new AvatarError(`头像图片过大（上限 ${AVATAR_IMAGE_MAX_BYTES / 1024 / 1024}MB）: ${avatar}`);
    loaded = { bytes: readFileSync(avatar), source: 'file' };
  }
  const valid = validateAvatarPng(loaded.bytes);
  if (!valid.ok) throw new AvatarError(valid.message);
  return loaded;
}

async function downloadAvatar(url: string, opts: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<Buffer> {
  const fetcher = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetcher(url, { method: 'GET', redirect: 'follow', signal: ac.signal });
    if (!res.ok) throw new AvatarError(`下载头像失败: HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > AVATAR_IMAGE_MAX_BYTES) {
      throw new AvatarError(`头像图片过大（上限 ${AVATAR_IMAGE_MAX_BYTES / 1024 / 1024}MB）`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > AVATAR_IMAGE_MAX_BYTES) throw new AvatarError(`头像图片过大（上限 ${AVATAR_IMAGE_MAX_BYTES / 1024 / 1024}MB）`);
    return bytes;
  } catch (err) {
    if (err instanceof AvatarError) throw err;
    throw new AvatarError(`下载头像失败: ${ac.signal.aborted ? '超时' : safeErrorMessage(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

// ─── neutral default icon ─────────────────────────────────────────────────────

let cachedDefaultIcon: Buffer | undefined;

/**
 * A neutral 512×512 PNG generated in-process (no bundled asset, no branding): a blue
 * rounded square with a white speech bubble. Deterministic.
 */
export function defaultAppIcon(): Buffer {
  if (cachedDefaultIcon) return Buffer.from(cachedDefaultIcon);
  const size = AVATAR_IMAGE_SIZE;
  const bg = [0x33, 0x70, 0xff];
  const fg = [0xff, 0xff, 0xff];
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const radius = 112;
  const inRoundedSquare = (x: number, y: number) => {
    const cx = Math.min(Math.max(x, radius), size - 1 - radius);
    const cy = Math.min(Math.max(y, radius), size - 1 - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  // Bubble: ellipse centred slightly above middle + a small tail at bottom-left.
  const inBubble = (x: number, y: number) => {
    const ex = (x - 256) / 150;
    const ey = (y - 236) / 112;
    if (ex * ex + ey * ey <= 1) return true;
    // tail triangle (170,320) (150,392) (232,338)
    const s = (ax: number, ay: number, bx: number, by: number) => (x - bx) * (ay - by) - (ax - bx) * (y - by);
    const d1 = s(170, 320, 150, 392);
    const d2 = s(150, 392, 232, 338);
    const d3 = s(232, 338, 170, 320);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const o = row + 1 + x * 4;
      if (!inRoundedSquare(x, y)) {
        raw[o + 3] = 0;
        continue;
      }
      const c = inBubble(x, y) ? fg : bg;
      raw[o] = c[0];
      raw[o + 1] = c[1];
      raw[o + 2] = c[2];
      raw[o + 3] = 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  cachedDefaultIcon = Buffer.concat([
    PNG_MAGIC,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return Buffer.from(cachedDefaultIcon);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}
