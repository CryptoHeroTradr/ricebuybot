import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Mint } from '../core/types.js';
import { BaseIngestor, type IngestorDeps } from './base.js';
import { toConfirmedTx } from './ws.js';
import type { ConfirmedTx } from './solana-types.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Fallback ingestor: Helius POSTs transactions to us instead of us holding a
 * socket open. Same normalizer, same events — only the transport differs.
 *
 * Mounted on the existing HTTP_PORT at POST /helius/webhook.
 */
export class HeliusWebhookIngestor extends BaseIngestor {
  readonly #secret: string;
  #running = false;

  constructor(secret: string, deps: IngestorDeps) {
    super(deps);
    this.#secret = secret;
  }

  override get connected(): boolean {
    return this.#running;
  }

  async start(): Promise<void> {
    this.#running = true;
    this.log.info('webhook ingestor ready at POST /helius/webhook');
  }

  async stop(): Promise<void> {
    this.#running = false;
  }

  // Helius pushes whatever the webhook is configured for; there is no per-mint
  // subscribe call. We still track the mint set, because ingest() classifies
  // against it and ignores everything else.
  protected override onSubscribe(mint: Mint): void {
    this.log.info({ mint }, 'webhook now watching mint');
  }

  /**
   * Constant-time compare. A plain `===` leaks the secret one byte at a time to
   * anyone who can measure response latency, and this endpoint is public.
   */
  #authorized(header: string | undefined): boolean {
    if (!header) return false;
    const a = Buffer.from(header);
    const b = Buffer.from(this.#secret);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * Returns true if it handled the request.
   *
   * ACK IMMEDIATELY, PROCESS ASYNC. Helius retries on a slow or non-200 response,
   * and a retry means the same buy arrives twice. We are protected against that
   * (the LRU and the send claim), but the cheapest duplicate is the one that
   * never gets sent — so we answer 200 before doing any work.
   */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/helius/webhook') return false;

    if (!this.#authorized(req.headers.authorization)) {
      this.log.warn({ ip: req.socket.remoteAddress }, 'webhook auth rejected');
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"ok":false}');
      return true;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        this.log.warn({ size }, 'webhook body too large; dropping');
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on('end', () => {
      if (aborted) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');

      // Deliberately after the response is flushed.
      queueMicrotask(() => this.#process(Buffer.concat(chunks).toString('utf8')));
    });

    return true;
  }

  #process(body: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      this.log.warn('webhook body was not JSON');
      return;
    }

    // Helius posts an ARRAY of transactions per delivery.
    const items = Array.isArray(payload) ? payload : [payload];
    for (const item of items) {
      const tx = normalizeShape(item);
      if (!tx) {
        this.log.warn('webhook item in an unexpected shape; ignoring');
        continue;
      }
      void this.ingest(tx);
    }
  }
}

/** Webhook items arrive as a bare getTransaction-shaped object, or Helius-wrapped. */
function normalizeShape(item: unknown): ConfirmedTx | null {
  if (!item || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;

  // Already getTransaction-shaped.
  if (o['transaction'] && o['meta'] !== undefined && typeof o['slot'] === 'number') {
    return o as unknown as ConfirmedTx;
  }
  return toConfirmedTx(item);
}
