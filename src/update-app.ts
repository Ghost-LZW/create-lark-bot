/**
 * Change an existing app's name / description / avatar via the console, then publish a
 * version so the change shows up in chats (the in-chat name/avatar follows the published
 * version, not base_info).
 *
 * Read first, write last, fail closed (ported from botmux src/services/open-platform-rename.ts):
 *   1. `app/<id>`            — current base info (langs / primaryLang / i18n / desc / name / avatar)
 *   2. `visible/online/<id>` — online visibility, mirrored into the new version
 *   3. upload icon (if any)  — no side effect on the app
 *   4. `base_info/<id>`      — FULL write: every configured language block is written back
 *   5. `app_version/create` + `publish/commit`
 * Any read/validation problem aborts before step 4.
 */
import { type OpenPlatformApiClient } from './console-client.js';
import { buildAppVersionCreatePayload, extractVersionId, nextAppVersion } from './console-ops.js';
import { uploadAppIcon } from './create-app.js';
import { applyUserPlaceholder, IdentityError, loadAvatar, validateAppName, type AppIdentity } from './identity.js';
import { asRecord, safeErrorMessage } from './util.js';
import { parseOnlineVisibility } from './visibility.js';

export type UpdateIdentityResult =
  | { ok: true; changed: Array<'name' | 'description' | 'avatar'>; versionId?: string; avatarUrl?: string }
  | { ok: false; reason: 'invalid_identity' | 'unreadable_base_info' | 'api_error'; message: string; error?: unknown };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Validate the base_info snapshot well enough to write it back in full without losing anything. */
export function parseBaseInfoSnapshot(payload: unknown) {
  const base = asRecord(asRecord(payload).data);
  const primaryLang = typeof base.primaryLang === 'string' && base.primaryLang ? base.primaryLang : 'zh_cn';
  const i18nCurrent = asRecord(base.i18n);
  let langs: string[];
  if (Array.isArray(base.langs) && base.langs.length > 0) {
    if (!base.langs.every((l): l is string => typeof l === 'string' && l !== '')) throw new Error('langs 形态未识别');
    if (new Set(base.langs).size !== base.langs.length) throw new Error('langs 含重复语言');
    langs = base.langs;
  } else {
    const extra = Object.keys(i18nCurrent).filter(k => k !== primaryLang);
    if (extra.length > 0) throw new Error(`没有返回 langs 而 i18n 含多语言（${extra.join(', ')}）`);
    langs = [primaryLang];
  }
  if (!langs.includes(primaryLang)) throw new Error(`primaryLang（${primaryLang}）不在 langs 内`);
  if (typeof base.desc !== 'string') throw new Error('没有返回应用描述（desc）');
  const i18nBlocks: Record<string, Record<string, unknown>> = {};
  for (const lang of langs) {
    const block = i18nCurrent[lang];
    if (!isPlainRecord(block)) throw new Error(`没有返回 ${lang} 的 i18n 信息`);
    i18nBlocks[lang] = block;
  }
  const name = typeof base.name === 'string' && base.name ? base.name : '';
  if (!name) throw new Error('没有返回应用当前名称');
  const avatar = typeof base.avatar === 'string' && base.avatar ? base.avatar : undefined;
  return { base, primaryLang, langs, desc: base.desc, i18nBlocks, name, avatar };
}

export async function updateOpenPlatformAppIdentity(
  client: OpenPlatformApiClient,
  appId: string,
  identity: AppIdentity,
  opts: { userName?: string; fetchImpl?: typeof fetch; changeLog?: string } = {},
): Promise<UpdateIdentityResult> {
  const newName = identity.name !== undefined ? applyUserPlaceholder(identity.name.trim(), opts.userName) : undefined;
  const newDesc = identity.description !== undefined ? applyUserPlaceholder(identity.description.trim(), opts.userName) : undefined;
  if (newName !== undefined) {
    const err = validateAppName(newName);
    if (err) return { ok: false, reason: 'invalid_identity', message: err };
  }
  let avatarBytes: Buffer | undefined;
  if (identity.avatar !== undefined) {
    try {
      avatarBytes = (await loadAvatar(identity.avatar, { fetchImpl: opts.fetchImpl })).bytes;
    } catch (err) {
      return { ok: false, reason: 'invalid_identity', message: safeErrorMessage(err) };
    }
  }
  if (newName === undefined && newDesc === undefined && !avatarBytes) return { ok: true, changed: [] };

  let snapshot: ReturnType<typeof parseBaseInfoSnapshot>;
  try {
    snapshot = parseBaseInfoSnapshot(await client.postJson(`/developers/v1/app/${appId}`, {}));
  } catch (err) {
    return { ok: false, reason: 'unreadable_base_info', message: `读取应用基础信息失败，已中止（未做任何修改）: ${safeErrorMessage(err)}`, error: err };
  }

  try {
    const visibility = parseOnlineVisibility(await client.postJson(`/developers/v1/visible/online/${appId}`, {}));
    const appVersion = nextAppVersion(await client.postJson(`/developers/v1/app_version/list/${appId}`, {}));
    const changed: Array<'name' | 'description' | 'avatar'> = [];
    let avatarUrl: string | undefined;
    if (avatarBytes) {
      avatarUrl = await uploadAppIcon(client, avatarBytes, 'avatar.png');
      changed.push('avatar');
    }
    const name = newName ?? snapshot.name;
    if (newName !== undefined && newName !== snapshot.name) changed.push('name');
    const desc = newDesc ?? snapshot.desc;
    if (newDesc !== undefined && newDesc !== snapshot.desc) changed.push('description');
    if (changed.length === 0) return { ok: true, changed };
    const i18n: Record<string, unknown> = {};
    for (const lang of snapshot.langs) {
      const cur = snapshot.i18nBlocks[lang];
      i18n[lang] = {
        ...cur,
        ...(newName !== undefined ? { name } : { name: typeof cur.name === 'string' && cur.name ? cur.name : snapshot.name }),
        ...(newDesc !== undefined ? { description: desc } : {}),
      };
    }
    const avatar = avatarUrl ?? snapshot.avatar;
    await client.postJson(`/developers/v1/base_info/${appId}`, {
      clientId: appId,
      name,
      desc,
      languages: snapshot.langs,
      i18n,
      ...(avatar ? { avatar } : {}),
    });
    const payload = buildAppVersionCreatePayload(appVersion, [], opts.changeLog ?? `Update bot ${changed.join(', ')}`) as unknown as Record<string, unknown>;
    payload.visibleSuggest = visibility.visibleSuggest;
    payload.blackVisibleSuggest = visibility.blackVisibleSuggest;
    const versionId = extractVersionId(await client.postJson(`/developers/v1/app_version/create/${appId}`, payload));
    if (!versionId) return { ok: false, reason: 'api_error', message: '基础信息已更新，但开放平台没有返回新版本 versionId；请到开放平台手动发布' };
    await client.postJson(`/developers/v1/publish/commit/${appId}/${versionId}`, { clientId: appId });
    return { ok: true, changed, versionId, ...(avatarUrl ? { avatarUrl } : {}) };
  } catch (err) {
    if (err instanceof IdentityError) return { ok: false, reason: 'invalid_identity', message: err.message };
    return { ok: false, reason: 'api_error', message: safeErrorMessage(err), error: err };
  }
}
