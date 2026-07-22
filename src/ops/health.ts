import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from './logger.js';

export interface HealthServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Everything /health reports. Supplied by a callback so this module stays dependency-free —
 * it must not import the ingestor, the pool or the queue, or a health check becomes a way to
 * create an import cycle.
 */
export interface HealthSnapshot {
  /** grammY's long-poll is running. False = the bot cannot receive commands or send cards. */
  readonly telegramPolling: boolean;
  readonly wsConnected: boolean;
  readonly activeMints: number;
  readonly solUsd: number | null;
  /** Seconds since the last buy we POSTED. Null when we have not posted one yet. */
  readonly lastBuyAgeSec: number | null;
  readonly queueDepth: number;
  readonly deliveredToday: number;
  readonly mediaItems: number;
  readonly mediaUploaded: number;
  readonly mediaPending: number;
}

/**
 * An extra route mounted on the same port. Returns true if it handled the
 * request. Used by the webhook ingestor so we do not open a second listener.
 */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => boolean;

/**
 * GET /health -> {"ok":true,"uptime":n}
 *
 * Deliberately tiny and dependency-free. It reports that the PROCESS is up; it
 * does not probe Helius or Telegram, because a health check that can be made to
 * fail by a third party is a health check that restarts you for no reason.
 */
export function startHealthServer(
  port: number,
  log: Logger,
  startedAtMs: number = Date.now(),
  routes: readonly RouteHandler[] = [],
  snapshot?: () => Promise<HealthSnapshot>,
): Promise<HealthServer> {
  const server: Server = createServer((req, res) => {
    for (const route of routes) {
      if (route(req, res)) return;
    }

    if (req.method === 'GET' && (req.url === '/health' || req.url === '/health/')) {
      const base = { ok: true, uptime: Math.floor((Date.now() - startedAtMs) / 1000) };

      if (!snapshot) {
        send(res, base);
        return;
      }

      // The snapshot reads local state only — no Helius call, no Telegram call. A health
      // check that a third party can make fail is a health check that restarts you for
      // somebody else's outage.
      void snapshot()
        .then((s) => send(res, { ...base, ...s }))
        .catch((err: unknown) => {
          log.error({ err: (err as Error).message }, 'health snapshot failed');
          send(res, { ...base, ok: false }, 500);
        });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"ok":false}');
  });

  function send(res: ServerResponse, body: unknown, status = 200): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
    res.end(json);
  }

  return new Promise<HealthServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const addr = server.address();
      const bound = typeof addr === 'object' && addr ? addr.port : port;
      log.info({ port: bound }, 'health server listening');
      resolve({
        port: bound,
        close: () =>
          new Promise<void>((res2, rej2) => {
            server.close((err) => (err ? rej2(err) : res2()));
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
