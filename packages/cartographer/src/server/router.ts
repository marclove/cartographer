import type { IncomingMessage, ServerResponse } from 'node:http';

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void> | void;

export interface Route {
  method: string;
  pattern: string;
  handler: RouteHandler;
}

/**
 * Match a URL pathname against a route pattern with `:param` segments.
 *
 * Returns a record of extracted parameters on match, or `null` if the
 * pathname does not match the pattern. Parameter values are URI-decoded.
 *
 * @example
 * ```ts
 * matchRoute('/api/nodes/abc-123', '/api/nodes/:id')
 * // => { id: 'abc-123' }
 *
 * matchRoute('/api/status', '/api/tree')
 * // => null
 * ```
 */
export function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const pathParts = pathname.split('/');
  const patternParts = pattern.split('/');
  if (pathParts.length !== patternParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}
