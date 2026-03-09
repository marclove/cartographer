import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * Creates a local HTTP server simulating three services with different
 * failure profiles. Each service tracks its own request count and
 * exhibits deterministic behavior:
 *
 * - /api      — Goes down (503) on requests 4–6, recovers after.
 * - /database — Gradually degrades (increasing latency) from request 7+.
 * - /queue    — Flaps (alternates 200/500) from request 5+.
 *
 * Deterministic profiles ensure the example produces interesting state
 * transitions: healthy → outage → recovery, with degradation and flapping
 * mixed in.
 */
export function createTestServer(): Promise<TestServer> {
  const requestCounts: Record<string, number> = {
    api: 0,
    database: 0,
    queue: 0,
  };

  const server = http.createServer((req, res) => {
    const service = req.url?.slice(1) ?? '';
    if (!(service in requestCounts)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown service' }));
      return;
    }

    requestCounts[service]++;
    const count = requestCounts[service];
    const { status, latency } = getServiceBehavior(service, count);

    setTimeout(() => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service,
        status: status === 200 ? 'ok' : 'error',
        requestCount: count,
      }));
    }, latency);
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        url: `http://localhost:${addr.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

function getServiceBehavior(
  service: string,
  requestCount: number,
): { status: number; latency: number } {
  switch (service) {
    case 'api':
      // Hard outage on requests 4–6
      if (requestCount >= 4 && requestCount <= 6) {
        return { status: 503, latency: 50 };
      }
      return { status: 200, latency: 20 };

    case 'database':
      // Gradual latency degradation from request 7+
      if (requestCount >= 7) {
        return { status: 200, latency: 200 + (requestCount - 7) * 100 };
      }
      return { status: 200, latency: 30 };

    case 'queue':
      // Flaps between up and down from request 5+
      if (requestCount >= 5 && requestCount % 2 === 0) {
        return { status: 500, latency: 10 };
      }
      return { status: 200, latency: 15 };

    default:
      return { status: 200, latency: 10 };
  }
}
