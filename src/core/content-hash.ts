import { createHash } from 'node:crypto';

/**
 * Compute a deterministic content hash from input parts.
 * Returns a truncated hex string (16 chars = 64 bits, sufficient for collision avoidance in small trees).
 */
export function computeContentHash(...parts: (string | string[])[]): string {
  const h = createHash('sha256');
  for (const part of parts) {
    if (Array.isArray(part)) {
      h.update(`[${part.join(',')}]`);
    } else {
      h.update(part);
    }
  }
  return h.digest('hex').slice(0, 16);
}
