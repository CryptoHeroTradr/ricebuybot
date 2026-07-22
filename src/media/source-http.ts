import type { MediaItem, Mint } from '../core/types.js';
import { PoolError } from './pool.js';
import { parseManifest, type PoolSnapshot } from './source-local.js';
import type { MediaSource } from './index.js';

/**
 * The pool lives somewhere else, and we speak to it over HTTP.
 *
 * FOR WHEN THE BOT IS NOT ON THE POOL'S BOX. It is not the default and it is not the
 * one to reach for: see LocalFsSource, which uploads real bytes and so gets Telegram's
 * 50MB ceiling instead of the 20MB it enforces on anything fetched by URL.
 *
 * Same interpretation as the local source — it hands back the same PoolSnapshot, parsed
 * and validated by the same function — so every behaviour downstream (diffing, missing
 * vs removed, rotation, tier fallback, the file_id cache) is identical. Only the
 * transport differs, and it stops here.
 *
 * Note we still fetch the BYTES ourselves and upload them, rather than passing Telegram
 * the URL. That keeps INVARIANT 3 intact (this bot mints its own file_ids from its own
 * upload) and keeps one code path for the cache.
 */
export class HttpManifestSource implements MediaSource {
  readonly #manifestUrl: string;
  readonly #timeoutMs: number;

  constructor(manifestUrl: string, timeoutMs = 10_000) {
    this.#manifestUrl = manifestUrl;
    this.#timeoutMs = timeoutMs;
  }

  /** Media URLs are resolved against the manifest's own URL, so the pool moves as one. */
  #urlFor(relPath: string): string {
    // rel_path carries a leading `<mint>/` segment; the pool is SERVED at the mint dir.
    const withoutMint = relPath.split('/').slice(1).join('/');
    return new URL(withoutMint, this.#manifestUrl).toString();
  }

  async #get(url: string): Promise<Response> {
    const res = await fetch(url, { signal: AbortSignal.timeout(this.#timeoutMs) });
    if (!res.ok) throw new PoolError(`GET ${url} -> ${res.status}`);
    return res;
  }

  async snapshot(mint: Mint): Promise<PoolSnapshot> {
    // `no-store`: the manifest is the MUTABLE index and is served `Cache-Control:
    // no-cache` for exactly this reason. A cached copy would make curation invisible.
    const res = await this.#get(this.#manifestUrl);
    return parseManifest(await res.json(), mint);
  }

  /**
   * Unknowable over HTTP: there is no directory listing, and there must not be — the
   * nginx config denies autoindex on purpose. /mediastats says "unknown" rather than
   * "zero", because reporting zero unpublished files when you cannot see the folder is a
   * lie that reads as reassurance.
   */
  async unpublished(): Promise<number | null> {
    return null;
  }

  /**
   * Unknowable over HTTP — _archive is denied by nginx, deliberately. An empty set means "I
   * cannot see it", and the caller leaves removed_at alone rather than guessing. On this source
   * a CLI archive therefore reads as `missing`, which keeps the meme in rotation; the DM 🗑
   * button still works, because that writes removed_at directly.
   */
  async archived(): Promise<ReadonlySet<string>> {
    return new Set();
  }

  async bytes(item: MediaItem): Promise<Buffer | null> {
    try {
      const res = await this.#get(this.#urlFor(item.relPath));
      return Buffer.from(await res.arrayBuffer());
    } catch {
      // Gone, or unreachable. Treated as `missing`: survivable, because a cached
      // file_id keeps working long after the bytes stop being fetchable.
      return null;
    }
  }
}
