import { createHash } from 'node:crypto';

/** Versioned concurrency check, never an authorization or a client price. */
export function quoteFingerprint(snapshot: unknown): string {
  return `v1:${createHash('sha256')
    .update(JSON.stringify(canonical(snapshot)))
    .digest('hex')}`;
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}
