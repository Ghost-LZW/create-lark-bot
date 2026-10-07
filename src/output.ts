/**
 * Persisting credentials without leaking them: JSON file (0600, parent dir created 0700)
 * and in-place `.env` updates (0600). Neither prints values.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RegisterBrand } from './register-app.js';

export interface StoredCredentials {
  appId: string;
  appSecret: string;
  brand: RegisterBrand;
  /** Scanner open_id from the SDK flow (app-scoped; see `owner` for the verified identity). */
  userOpenId?: string;
  owner?: { unionId?: string; openId?: string; verified: { unionId: boolean; openId: boolean } };
}

function ensurePrivateDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Write credentials as JSON with mode 0600 (also tightened when the file already existed). */
export function writeCredentialsFile(path: string, credentials: StoredCredentials): void {
  ensurePrivateDir(dirname(path));
  writeFileSync(path, JSON.stringify(credentials, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* non-POSIX filesystem */
  }
}

export function readCredentialsFile(path: string): StoredCredentials {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<StoredCredentials>;
  if (!raw.appId || !raw.appSecret) throw new Error(`${path}: not a credentials file (appId/appSecret missing)`);
  return { ...raw, appId: raw.appId, appSecret: raw.appSecret, brand: raw.brand === 'lark' ? 'lark' : 'feishu' };
}

function quoteEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:@,+-]*$/.test(value) ? value : JSON.stringify(value);
}

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

/**
 * Insert or update `KEY=value` lines in place; other lines (comments, blank lines, other
 * keys, `export` prefixes) are preserved. Keys listed in `mergeListKeys` are comma lists
 * that are unioned instead of replaced. The file ends up 0600.
 */
export function updateEnvFile(
  path: string,
  vars: Record<string, string | undefined>,
  opts: { mergeListKeys?: string[] } = {},
): { updated: string[]; added: string[] } {
  ensurePrivateDir(dirname(path));
  const lines = existsSync(path) ? readFileSync(path, 'utf-8').split('\n') : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const updated: string[] = [];
  const added: string[] = [];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid env var name: ${key}`);
    const re = new RegExp(`^(\\s*(?:export\\s+)?)${key}=(.*)$`);
    const idx = lines.findIndex(line => re.test(line));
    let next = value;
    if (idx >= 0 && opts.mergeListKeys?.includes(key)) {
      const old = unquote(lines[idx].replace(re, '$2'));
      next = [...new Set([...old.split(','), ...value.split(',')].map(s => s.trim()).filter(Boolean))].join(',');
    }
    if (idx >= 0) {
      const prefix = lines[idx].replace(re, '$1');
      lines[idx] = `${prefix}${key}=${quoteEnvValue(next)}`;
      updated.push(key);
    } else {
      lines.push(`${key}=${quoteEnvValue(next)}`);
      added.push(key);
    }
  }
  writeFileSync(path, lines.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* non-POSIX filesystem */
  }
  return { updated, added };
}
