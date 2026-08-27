/**
 * Browser-safe HTTP client for the external Agent Bridge.
 *
 * Uses global fetch (no node builtins) so it can run in the demo SPA and in
 * artifactctl. Every request to a configured bridge carries a pairing token
 * as an `Authorization: Bearer` header; production-grade auth is explicitly
 * out of scope for this MVP (loopback + explicit token only).
 */

import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeReceipt,
  type BridgeReceiptState,
  type BridgeStore,
  type BridgeSubmitRequest,
  BridgeError,
} from './bridge.js';
import { AG_UI_BRIDGE_WATCH_PATH, isAgUiEvent, type AgUiEvent } from './ag-ui.js';
import { type ContextBundle } from './types.js';

export interface BridgeClientOptions {
  baseURL: string;
  token?: string;
  /** Opaque Artifact session for non-browser callers. */
  sessionToken?: string;
  /** Pass `include` when using an HttpOnly Artifact session cookie cross-origin. */
  credentials?: RequestInit['credentials'];
  fetchImpl?: typeof fetch;
}

export interface AgUiWatchOptions {
  state?: BridgeReceiptState;
  bundleId?: string;
  /** Request the full ContextBundle as an explicit custom event. */
  includeContext?: boolean;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class BridgeClient implements BridgeStore {
  readonly baseURL: string;
  private readonly token?: string;
  private readonly sessionToken?: string;
  private readonly credentials?: RequestInit['credentials'];
  private readonly fetchImpl: typeof fetch;

  constructor(options: BridgeClientOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/, '');
    this.token = options.token;
    this.sessionToken = options.sessionToken;
    this.credentials = options.credentials;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** POST a bundle to the bridge; returns the receipt (idempotent replay-safe). */
  async submit(req: BridgeSubmitRequest): Promise<BridgeReceipt> {
    return this.httpPost('/v1/submit', req);
  }

  async get(bundleId: string): Promise<BridgeReceipt | undefined> {
    try {
      return await this.httpGet(`/v1/bundles/${encodeURIComponent(bundleId)}`);
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'not_found') return undefined;
      throw error;
    }
  }

  /** Fetch the full context payload for an authorized Agent receiver. */
  async getBundle(bundleId: string): Promise<ContextBundle | undefined> {
    try {
      const response = await this.httpGet<{ bundle: ContextBundle }>(
        `/v1/bundles/${encodeURIComponent(bundleId)}/context`,
      );
      return response.bundle;
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'not_found') return undefined;
      throw error;
    }
  }

  list(state?: BridgeReceiptState): Promise<BridgeReceipt[]> {
    const q = state !== undefined ? `?state=${encodeURIComponent(state)}` : '';
    return this.httpGet<{ receipts: BridgeReceipt[] }>(`/v1/bundles${q}`).then((r) => r.receipts);
  }

  async ack(bundleId: string): Promise<BridgeReceipt> {
    return this.httpPost(`/v1/bundles/${encodeURIComponent(bundleId)}/ack`, {});
  }

  async resume(bundleId: string): Promise<BridgeReceipt> {
    return this.httpPost(`/v1/bundles/${encodeURIComponent(bundleId)}/resume`, {});
  }

  async complete(bundleId: string): Promise<BridgeReceipt> {
    return this.httpPost(`/v1/bundles/${encodeURIComponent(bundleId)}/complete`, {});
  }

  async reject(bundleId: string, reason: string): Promise<BridgeReceipt> {
    return this.httpPost(`/v1/bundles/${encodeURIComponent(bundleId)}/reject`, { reason });
  }

  /**
   * Stream receipt changes as SSE. Yields `{ kind: 'receipt', receipt }` for
   * each change, `{ kind: 'done' }` when the stream closes. A `timeoutMs` > 0
   * aborts the connection after that many ms (so a CLI can exit without the
   * SSE connection being closed by the server).
   */
  async *watch(
    state?: BridgeReceiptState,
    opts: { timeoutMs?: number } = {},
  ): AsyncIterable<{ kind: 'receipt'; receipt: BridgeReceipt } | { kind: 'done'; reason: string }> {
    const params = new URLSearchParams();
    if (state !== undefined) params.set('state', state);
    const controller = new AbortController();
    const timer = (opts.timeoutMs ?? 0) > 0 ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseURL}/v1/watch?${params}`, {
        signal: controller.signal,
        ...(this.credentials !== undefined ? { credentials: this.credentials } : {}),
        headers: {
          Accept: 'text/event-stream',
          ...this.authHeaders(),
        },
      });
    } catch (error) {
      if (timer) clearTimeout(timer);
      if (error instanceof Error && error.name === 'AbortError' && (opts.timeoutMs ?? 0) > 0) {
        yield { kind: 'done', reason: 'timeout' };
        return;
      }
      throw error;
    }
    if (!response.ok || !response.body) {
      if (timer) clearTimeout(timer);
      throw new BridgeError('watch_failed', `watch stream failed: HTTP ${response.status}`, response.status);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let aborted = false;
    try {
      while (true) {
        let chunk: { done: boolean; value?: Uint8Array };
        try {
          chunk = await reader.read();
        } catch (error) {
          if (timer && (error as Error).name === 'AbortError') {
            aborted = true;
            break;
          }
          throw error;
        }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const payload = JSON.parse(line.slice(6)) as { type?: string; receipt?: BridgeReceipt };
            if (payload.type === 'receipt' && payload.receipt) yield { kind: 'receipt', receipt: payload.receipt };
          }
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
      try {
        await reader.cancel();
      } catch {
        // The fetch abort may have already closed the stream.
      }
      reader.releaseLock();
    }
    yield { kind: 'done', reason: aborted ? 'timeout' : 'closed' };
  }

  /**
   * Stream the bridge's AG-UI-compatible event projection as raw BaseEvents.
   * The bridge emits lifecycle + namespaced CUSTOM events; it deliberately
   * does not turn structured context into chat text.  A timeout is important
   * for CLI consumers because an SSE subscription is otherwise long-lived.
   */
  async *watchAgUi(
    options: AgUiWatchOptions = {},
  ): AsyncIterable<{ kind: 'event'; event: AgUiEvent } | { kind: 'done'; reason: string }> {
    const params = new URLSearchParams();
    if (options.state !== undefined) params.set('state', options.state);
    if (options.bundleId !== undefined) params.set('bundle_id', options.bundleId);
    if (options.includeContext) params.set('include_context', '1');
    const query = params.toString();
    const controller = new AbortController();
    const timer = (options.timeoutMs ?? 0) > 0 ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseURL}${AG_UI_BRIDGE_WATCH_PATH}${query ? `?${query}` : ''}`, {
        signal: controller.signal,
        ...(this.credentials !== undefined ? { credentials: this.credentials } : {}),
        headers: {
          Accept: 'text/event-stream',
          ...this.authHeaders(),
        },
      });
    } catch (error) {
      if (timer) clearTimeout(timer);
      if (error instanceof Error && error.name === 'AbortError' && (options.timeoutMs ?? 0) > 0) {
        yield { kind: 'done', reason: 'timeout' };
        return;
      }
      throw error;
    }
    if (!response.ok || !response.body) {
      if (timer) clearTimeout(timer);
      throw new BridgeError('watch_failed', `AG-UI watch stream failed: HTTP ${response.status}`, response.status);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let aborted = false;
    try {
      while (true) {
        let chunk: { done: boolean; value?: Uint8Array };
        try {
          chunk = await reader.read();
        } catch (error) {
          if (timer && (error as Error).name === 'AbortError') {
            aborted = true;
            break;
          }
          throw error;
        }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            let payload: unknown;
            try {
              payload = JSON.parse(line.slice(6));
            } catch {
              throw new BridgeError('invalid_response', 'AG-UI watch returned invalid JSON');
            }
            if (!isAgUiEvent(payload)) {
              throw new BridgeError('invalid_response', 'AG-UI watch returned an invalid event');
            }
            yield { kind: 'event', event: payload };
          }
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
      try {
        await reader.cancel();
      } catch {
        // The fetch abort may have already closed the stream.
      }
      reader.releaseLock();
    }
    yield { kind: 'done', reason: aborted ? 'timeout' : 'closed' };
  }

  private async httpGet<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseURL}${path}`, {
      ...(this.credentials !== undefined ? { credentials: this.credentials } : {}),
      headers: this.authHeaders(),
    });
    return this.parse(response);
  }

  private async httpPost<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseURL}${path}`, {
      method: 'POST',
      ...(this.credentials !== undefined ? { credentials: this.credentials } : {}),
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
    });
    return this.parse(response);
  }

  private authHeaders(): Record<string, string> {
    if (this.sessionToken) {
      return {
        Authorization: `Artifact-Session ${this.sessionToken}`,
        ...(this.token ? { 'X-Bridge-Token': this.token } : {}),
      };
    }
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  private async parse(response: Response): Promise<never | any> {
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text === '' ? null : JSON.parse(text);
    } catch {
      throw new BridgeError('invalid_response', `non-JSON response (HTTP ${response.status})`, response.status);
    }
    if (!response.ok) {
      if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === 'string') {
        throw new BridgeError(payload.error.code, String(payload.error.message ?? response.statusText), response.status);
      }
      throw new BridgeError('http_error', `HTTP ${response.status}`, response.status);
    }
    return payload as any;
  }
}

export { BRIDGE_PROTOCOL_VERSION };
