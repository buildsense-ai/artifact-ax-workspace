/**
 * JsonFileBridgeStore — durable, Node-only BridgeStore adapter.
 *
 * Wraps the shared InMemoryBridgeStore through its pure snapshot/restore seam
 * and persists state to one atomic JSON file. Writes go to a temp file in the
 * same directory, fsync, then rename over the target, so a crash mid-write
 * never corrupts the last good state. Every mutation (submit/ack/resume/
 * complete/reject/expire) awaits its serialized write before resolving, and
 * writes are queued one at a time so concurrent mutations can never interleave
 * stale snapshots onto disk. Restarting the bridge over the same file simply
 * re-opens it: idempotent replays, stale-revision rejection, and conflict
 * refusals all keep their exact behavior.
 *
 * Deliberately Node-only: this file lives in apps/artifact-bridge and imports
 * node:fs; @artifact-ax/trigger stays browser-safe and fs-free.
 *
 * Error behavior is explicit:
 *   - missing store file            -> start with an empty store (first run)
 *   - unreadable file (EACCES, ...) -> open() rejects (operational error)
 *   - malformed JSON / bad shape    -> open() rejects with BridgeStoreFileError
 *   - write failure (ENOSPC, ...)   -> the mutation rejects; in-memory state
 *                                      stays authoritative for this process
 */

import { randomBytes } from 'node:crypto';
import { mkdir, open as openFile, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  BridgeStoreSnapshotError,
  InMemoryBridgeStore,
  type BridgeReceipt,
  type BridgeReceiptState,
  type BridgeStore,
  type BridgeStoreOptions,
  type BridgeStoreSnapshot,
  type BridgeSubmitRequest,
  type ContextBundle,
} from '@artifact-ax/trigger';

/** Explicit, typed failure for the durable store file (corrupt or I/O). */
export class BridgeStoreFileError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`bridge store file '${path}': ${message}`);
    this.name = 'BridgeStoreFileError';
    this.path = path;
  }
}

/**
 * Durable BridgeStore persisted to one JSON file at `filePath`.
 *
 * Use `JsonFileBridgeStore.open(filePath)` to load existing state (or start
 * empty when the file does not exist yet). After construction, the instance
 * behaves like any other BridgeStore; `flush()` drains any queued write (all
 * mutations already await their writes, so it is only needed for graceful
 * shutdown or tests of fire-and-forget paths).
 */
export class JsonFileBridgeStore implements BridgeStore {
  private readonly inner: InMemoryBridgeStore;
  private readonly filePath: string;
  /** Serialized single-writer queue: every mutation appends one atomic write. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string, options: BridgeStoreOptions = {}) {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      throw new TypeError('JsonFileBridgeStore requires a non-empty store file path');
    }
    this.filePath = filePath;
    this.inner = new InMemoryBridgeStore(options);
  }

  /** Open (or create) the durable store. Rejects with BridgeStoreFileError on
   * an unreadable or corrupt file before any mutation can run. */
  static async open(filePath: string, options: BridgeStoreOptions = {}): Promise<JsonFileBridgeStore> {
    const store = new JsonFileBridgeStore(filePath, options);
    await store.load();
    return store;
  }

  async submit(req: BridgeSubmitRequest): Promise<BridgeReceipt> {
    const receipt = await this.inner.submit(req);
    await this.persist();
    return receipt;
  }

  async get(bundleId: string): Promise<BridgeReceipt | undefined> {
    return this.inner.get(bundleId);
  }

  async getBundle(bundleId: string): Promise<ContextBundle | undefined> {
    return this.inner.getBundle(bundleId);
  }

  async list(state?: BridgeReceiptState): Promise<BridgeReceipt[]> {
    return this.inner.list(state);
  }

  async ack(bundleId: string): Promise<BridgeReceipt> {
    const receipt = await this.inner.ack(bundleId);
    await this.persist();
    return receipt;
  }

  async resume(bundleId: string): Promise<BridgeReceipt> {
    const receipt = await this.inner.resume(bundleId);
    await this.persist();
    return receipt;
  }

  async complete(bundleId: string): Promise<BridgeReceipt> {
    const receipt = await this.inner.complete(bundleId);
    await this.persist();
    return receipt;
  }

  async reject(bundleId: string, reason: string): Promise<BridgeReceipt> {
    const receipt = await this.inner.reject(bundleId, reason);
    await this.persist();
    return receipt;
  }

  async expireNow(): Promise<BridgeReceipt[]> {
    const expired = this.inner.expireNow();
    if (expired.length > 0) await this.persist();
    return expired;
  }

  /** Drain the write queue so queued state is on disk (graceful shutdown). */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return; // first run: start empty
      throw new BridgeStoreFileError(this.filePath, `cannot read store file: ${messageOf(error)}`);
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      throw new BridgeStoreFileError(this.filePath, `store file is not valid JSON: ${messageOf(error)}`);
    }
    try {
      this.inner.restore(data as BridgeStoreSnapshot);
    } catch (error) {
      if (error instanceof BridgeStoreSnapshotError) {
        throw new BridgeStoreFileError(this.filePath, `store file is corrupt: ${error.message}`);
      }
      throw error;
    }
  }

  /** Append one atomic write to the serialized queue; resolves once durable. */
  private persist(): Promise<void> {
    const write = this.writeChain.then(() => this.writeAtomic());
    // Keep the chain alive after a failed write so later mutations still
    // persist; the failing caller observes the rejection.
    this.writeChain = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  private async writeAtomic(): Promise<void> {
    const snapshot = this.inner.snapshot();
    const data = `${JSON.stringify(snapshot, null, 2)}\n`;
    const dir = dirname(this.filePath);
    // A CLI-provided path may point at a not-yet-created directory. Keep the
    // durable store self-contained and restrict a newly-created directory to
    // its owner; existing directory permissions are left untouched.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${basename(this.filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    // Context bundles can contain user data; do not create a world-readable
    // temporary file before the atomic rename.
    const handle = await openFile(tmp, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(data, 'utf8');
        await handle.sync(); // contents durable before the rename
      } finally {
        await handle.close();
      }
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
    try {
      await rename(tmp, this.filePath); // atomic replace over the target
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
