/**
 * Small shared helpers (record narrowing, string picking, secret-safe error text).
 */

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/** pickString on the record itself, then on its `data` child. */
export function pickPayloadString(payload: unknown, keys: string[]): string | undefined {
  const record = asRecord(payload);
  return pickString(record, keys) ?? pickString(asRecord(record.data), keys);
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Long opaque tokens (secrets, cookies, csrf tokens) are masked in any message we surface. */
const LONG_TOKEN = /[A-Za-z0-9_=-]{24,}/g;

/**
 * Error text that is safe to print: walks the `cause` chain (undici wraps the real
 * network reason in `TypeError('fetch failed', { cause })`) and masks long tokens.
 */
export function safeErrorMessage(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof AggregateError && !current.message && current.errors.length > 0) {
      current = current.errors[0];
    }
    const message = current instanceof Error ? current.message : String(current);
    const code = (current as { code?: unknown }).code;
    const part = typeof code === 'string' && code && !message.includes(code)
      ? (message ? `${message} (${code})` : code)
      : message;
    if (part && parts[parts.length - 1] !== part) parts.push(part);
    current = current instanceof Error ? current.cause : undefined;
  }
  const combined = parts.join(': ') || (err instanceof Error ? err.message : String(err));
  return combined.replace(LONG_TOKEN, '***');
}

/** Replace every occurrence of the given secrets (and any long token) with `***`. */
export function redactSecrets(text: string, secrets: Array<string | undefined> = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('***');
  }
  return out.replace(LONG_TOKEN, '***');
}
