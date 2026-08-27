/**
 * Artifact Bridge server (apps/artifact-bridge).
 *
 * A small loopback HTTP API that receives ContextBundles through the artifact
 * bridge protocol and tracks them through explicit receipt states
 * (accepted / queued / needs_confirm / acknowledged / completed / rejected /
 * expired). An external Agent consumes the compact receipts and explicitly
 * fetches a payload through the `artifactctl context` command group or HTTP.
 *
 * Safety defaults:
 *   - Binds to loopback (127.0.0.1) unless `--host` is overridden.
 *   - Auth defaults to an explicit pairing token (Authorization: Bearer).
 *     An optional CatsCo introspection adapter can issue an Artifact-side
 *     opaque session; native OAuth/OIDC remains out of scope.
 *   - CORS is opened for localhost SPA development only, not production auth.
 *
 * The state seam is `BridgeStore` (default InMemoryBridgeStore); swapping in a
 * durable store does not change the protocol or routes.
 * `GET /v1/ag-ui/watch` is an optional AG-UI-compatible projection of those
 * receipts, not a model runner or a CatsCo chat path.
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  AuthError,
  ArtifactAuthService,
  hasScope,
  publicSession,
  type ArtifactSession,
} from '@artifact-ax/auth';
import {
  AG_UI_BRIDGE_CONTEXT_EVENT,
  AG_UI_BRIDGE_RECEIPT_EVENT,
  AG_UI_BRIDGE_WATCH_PATH,
  AgUiBridgeProjector,
  BRIDGE_PROTOCOL_VERSION,
  BridgeError,
  hasMinimalBundle,
  type AgUiEvent,
  type BridgeReceipt,
  type BridgeReceiptState,
  type BridgeStore,
  type BridgeSubmitRequest,
  type ContextBundle,
  InMemoryBridgeStore,
} from '@artifact-ax/trigger';

export interface ArtifactBridgeServerOptions {
  /** State seam; default InMemoryBridgeStore. */
  store?: BridgeStore;
  /** Optional pairing token. When set, /v1/* requires it. */
  token?: string;
  /** Comma-separated origin patterns allowed for browser requests. */
  corsOrigins?: string;
  /** Bind address; keep the loopback default unless explicitly deploying. */
  host?: string;
  /** Optional CatsCo-backed session boundary; disabled by default. */
  auth?: ArtifactBridgeAuthOptions;
}

export interface ArtifactBridgeAuthOptions {
  /** Service that exchanges CatsCo credentials for opaque Artifact sessions. */
  service: ArtifactAuthService;
  /** HttpOnly cookie name; keep stable so the SPA can use credentials: include. */
  cookieName?: string;
  /** Add Secure when the bridge is served over HTTPS. */
  secureCookie?: boolean;
  /** Scope required for read routes; set null to disable all scope checks. */
  requiredScope?: string | null;
  /** Scope required for bridge writes/lifecycle mutations (default artifact:execute). */
  requiredWriteScope?: string | null;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function sendJSON(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(payload));
}

function writeSSE(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeAgUiSSE(res: ServerResponse, event: AgUiEvent): void {
  // AG-UI's HTTP transport carries one JSON BaseEvent in each SSE data
  // frame.  Do not wrap this in the bridge's `{type: receipt}` envelope: a
  // host AG-UI client should be able to pass the parsed object through.
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function responseClosed(res: ServerResponse): boolean {
  return res.writableEnded || res.destroyed;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface AgUiWatcher {
  res: ServerResponse;
  state?: BridgeReceiptState;
  bundleId?: string;
  includeContext: boolean;
  actorId?: string;
  projector: AgUiBridgeProjector;
  /** Serialize async context lookups and writes per connection. */
  queue: Promise<void>;
}

interface ReceiptWatcher {
  res: ServerResponse;
  state?: BridgeReceiptState;
  actorId?: string;
  /** Serialize async ownership lookups and writes for one connection. */
  queue: Promise<void>;
}

type RequestAuth =
  | { kind: 'open' }
  | { kind: 'pairing' }
  | { kind: 'session'; token: string; session: ArtifactSession }
  | { kind: 'denied'; error: AuthError };

export class ArtifactBridgeServer {
  private readonly store: BridgeStore;
  private readonly token?: string;
  private readonly corsOrigins: string[];
  private readonly host: string;
  private readonly auth?: ArtifactBridgeAuthOptions;
  private readonly authCookieName: string;
  private readonly server: Server;
  private readonly watchers = new Map<ServerResponse, ReceiptWatcher>();
  private readonly agUiWatchers = new Map<ServerResponse, AgUiWatcher>();

  constructor(options: ArtifactBridgeServerOptions = {}) {
    this.store = options.store ?? new InMemoryBridgeStore();
    this.token = options.token;
    this.corsOrigins = (options.corsOrigins ?? 'http://127.0.0.1:*,http://localhost:*,http://[::1]:*')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    this.host = options.host ?? '127.0.0.1';
    this.auth = options.auth;
    this.authCookieName = options.auth?.cookieName ?? 'artifact_ax_session';
    if (this.auth !== undefined && !isLoopbackHost(this.host)) {
      throw new AuthError(
        'invalid_config',
        'transitional CatsCo session auth is loopback-only; use a native OAuth/OIDC edge for public deployments',
        500,
      );
    }
    if (!/^[A-Za-z0-9_-]+$/.test(this.authCookieName)) {
      throw new AuthError('invalid_config', 'auth cookieName must contain only letters, numbers, _ or -', 500);
    }
    this.server = createServer((req, res) => void this.route(req, res));
  }

  listen(port?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once('error', onError);
      this.server.listen(port, this.host, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
  }

  address(): { port: number } | null {
    const addr = this.server.address();
    if (addr === null || typeof addr === 'string') return null;
    return { port: addr.port };
  }

  close(): Promise<void> {
    for (const res of this.watchers.keys()) res.end();
    this.watchers.clear();
    for (const watcher of this.agUiWatchers.values()) watcher.res.end();
    this.agUiWatchers.clear();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private pairingAuthorized(req: IncomingMessage): boolean {
    if (!this.token) return false;
    const header = req.headers['authorization'];
    if (typeof header === 'string' && secureEquals(header, `Bearer ${this.token}`)) return true;
    const alt = req.headers['x-bridge-token'];
    return typeof alt === 'string' && secureEquals(alt, this.token);
  }

  private sessionToken(req: IncomingMessage): string | undefined {
    const authorization = req.headers['authorization'];
    if (typeof authorization === 'string' && authorization.startsWith('Artifact-Session ')) {
      const token = authorization.slice('Artifact-Session '.length).trim();
      if (token !== '') return token;
    }
    const header = req.headers['x-artifact-session'];
    if (typeof header === 'string' && header.trim() !== '') return header.trim();
    const cookies = parseCookies(req.headers.cookie);
    const cookie = cookies.get(this.authCookieName);
    return cookie === undefined || cookie === '' ? undefined : cookie;
  }

  private catsCoUserToken(req: IncomingMessage): string | undefined {
    const explicit = req.headers['x-catsco-user-token'];
    if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
    const authorization = req.headers['authorization'];
    if (typeof authorization === 'string') {
      if (authorization.startsWith('CatsCo ')) {
        const token = authorization.slice('CatsCo '.length).trim();
        if (token !== '') return token;
      }
      // With no pairing token, accepting a plain Bearer header is convenient
      // for a same-origin host.  When pairing is configured the ambiguity is
      // unsafe, so callers must use X-CatsCo-User-Token or CatsCo <jwt>.
      if (!this.token && authorization.startsWith('Bearer ')) {
        const token = authorization.slice('Bearer '.length).trim();
        if (token !== '') return token;
      }
    }
    return undefined;
  }

  private applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && this.corsOrigins.some((pattern) => this.originMatches(origin, pattern))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Bridge-Token, X-CatsCo-User-Token, X-Artifact-Session',
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (typeof origin === 'string' && this.corsOrigins.some((pattern) => this.originMatches(origin, pattern))) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
  }

  private originMatches(origin: string, pattern: string): boolean {
    if (pattern === '*') return true;
    return pattern.endsWith('*') ? origin.startsWith(pattern.slice(0, -1)) : origin === pattern;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.applyCors(req, res);
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const path = url.pathname;
    const query = url.searchParams;

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Auth exchange is intentionally separate from bridge authorization:
      // the caller presents a CatsCo user credential, while the optional
      // pairing token protects the local endpoint from unrelated processes.
      if (path === '/v1/auth/exchange' && req.method === 'POST') {
        await this.handleAuthExchange(req, res);
        return;
      }
      if (path === '/v1/auth/session' && req.method === 'GET') {
        await this.handleAuthSession(req, res);
        return;
      }
      if (path === '/v1/auth/logout' && req.method === 'POST') {
        await this.handleAuthLogout(req, res);
        return;
      }

      const auth = await this.authenticate(req, path);
      if (auth !== null && auth.kind === 'denied') {
        this.sendError(res, auth.error);
        return;
      }
      if (auth === null && path.startsWith('/v1/')) {
        sendJSON(res, 401, { error: { code: 'unauthorized', message: 'missing or invalid pairing token/session credential' } });
        return;
      }

      // Expiry is opportunistic in the in-memory MVP. A durable store can omit
      // the optional method and implement its own retention policy.
      await this.sweepExpired();
      if (path === '/v1/health') {
        sendJSON(res, 200, {
          ok: true,
          protocol: BRIDGE_PROTOCOL_VERSION,
          auth: {
            session_exchange: this.auth !== undefined,
            cookie: this.auth === undefined ? undefined : this.authCookieName,
            required_scope: this.auth?.requiredScope === null ? null : this.auth?.requiredScope ?? 'artifact:read',
            required_write_scope:
              this.auth?.requiredScope === null
                ? null
                : this.auth?.requiredWriteScope === null
                  ? null
                  : this.auth?.requiredWriteScope ?? 'artifact:execute',
          },
          ag_ui_projection: {
            path: AG_UI_BRIDGE_WATCH_PATH,
            events: ['RUN_STARTED', 'CUSTOM', 'RUN_FINISHED'],
            custom_events: [AG_UI_BRIDGE_RECEIPT_EVENT, AG_UI_BRIDGE_CONTEXT_EVENT],
          },
        });
        return;
      }
      if (path === '/v1/submit' && req.method === 'POST') {
        await this.handleSubmit(req, res, auth);
        return;
      }
      if (path === '/v1/bundles' && req.method === 'GET') {
        const state = query.get('state');
        if (state !== null && !isReceiptState(state)) {
          sendJSON(res, 400, { error: { code: 'invalid_request', message: `unknown receipt state '${state}'` } });
          return;
        }
        const receipts = await this.visibleReceipts(state ?? undefined, auth);
        sendJSON(res, 200, { protocol_version: BRIDGE_PROTOCOL_VERSION, receipts });
        return;
      }
      const contextGet = /^\/v1\/bundles\/([^/]+)\/context$/.exec(path);
      if (contextGet && req.method === 'GET') {
        let bundleId: string;
        try {
          bundleId = decodeURIComponent(contextGet[1]!);
        } catch {
          sendJSON(res, 400, { error: { code: 'invalid_request', message: 'bundle id is not valid URL encoding' } });
          return;
        }
        if (typeof this.store.getBundle !== 'function') {
          sendJSON(res, 501, { error: { code: 'not_implemented', message: 'this bridge store does not expose context payloads' } });
          return;
        }
        const bundle = await this.authorizedBundle(bundleId, auth);
        if (!bundle) {
          sendJSON(res, 404, { error: { code: 'not_found', message: `no bundle '${bundleId}'` } });
          return;
        }
        sendJSON(res, 200, { protocol_version: BRIDGE_PROTOCOL_VERSION, bundle });
        return;
      }
      const single = /^\/v1\/bundles\/([^/]+)\/(ack|resume|complete|reject)$/.exec(path);
      if (single && req.method === 'POST') {
        const [, encodedBundleId, op] = single;
        let bundleId: string;
        try {
          bundleId = decodeURIComponent(encodedBundleId!);
        } catch {
          sendJSON(res, 400, { error: { code: 'invalid_request', message: 'bundle id is not valid URL encoding' } });
          return;
        }
        await this.handleMutation(req, res, bundleId, op as 'ack' | 'resume' | 'complete' | 'reject', auth);
        return;
      }
      const singleGet = /^\/v1\/bundles\/([^/]+)$/.exec(path);
      if (singleGet && req.method === 'GET') {
        let bundleId: string;
        try {
          bundleId = decodeURIComponent(singleGet[1]!);
        } catch {
          sendJSON(res, 400, { error: { code: 'invalid_request', message: 'bundle id is not valid URL encoding' } });
          return;
        }
        const receipt = await this.store.get(bundleId);
        if (!receipt) {
          sendJSON(res, 404, { error: { code: 'not_found', message: `no bundle '${bundleId}'` } });
          return;
        }
        if (!(await this.canAccessBundle(bundleId, auth))) {
          sendJSON(res, 404, { error: { code: 'not_found', message: `no bundle '${bundleId}'` } });
          return;
        }
        sendJSON(res, 200, receipt);
        return;
      }
      if (path === AG_UI_BRIDGE_WATCH_PATH && req.method === 'GET') {
        const state = query.get('state');
        if (state !== null && !isReceiptState(state)) {
          sendJSON(res, 400, { error: { code: 'invalid_request', message: `unknown receipt state '${state}'` } });
          return;
        }
        const bundleId = query.get('bundle_id');
        if (bundleId !== null && bundleId.trim() === '') {
          sendJSON(res, 400, { error: { code: 'invalid_request', message: 'bundle_id must be non-empty' } });
          return;
        }
        const includeContextValue = query.get('include_context');
        if (
          includeContextValue !== null &&
          includeContextValue !== '1' &&
          includeContextValue !== 'true' &&
          includeContextValue !== '0' &&
          includeContextValue !== 'false'
        ) {
          sendJSON(res, 400, { error: { code: 'invalid_request', message: 'include_context must be 0, 1, true, or false' } });
          return;
        }
        await this.handleAgUiWatch(
          req,
          res,
          state,
          bundleId ?? undefined,
          includeContextValue === '1' || includeContextValue === 'true',
          auth,
        );
        return;
      }
      if (path === '/v1/watch' && req.method === 'GET') {
        const state = query.get('state');
        if (state !== null && !isReceiptState(state)) {
          sendJSON(res, 400, { error: { code: 'invalid_request', message: `unknown receipt state '${state}'` } });
          return;
        }
        await this.handleWatch(req, res, state, auth);
        return;
      }
      sendJSON(res, 404, { error: { code: 'not_found', message: `unknown route ${req.method} ${path}` } });
    } catch (error) {
      this.sendError(res, error);
    }
  }

  private async authenticate(req: IncomingMessage, path: string): Promise<RequestAuth | null> {
    const pairing = this.pairingAuthorized(req);
    if (pairing) return { kind: 'pairing' };
    // A bridge with no configured credential remains the intentionally open
    // local demo surface.  Once either pairing or session auth is configured,
    // all data routes require one of them.
    if (path === '/v1/health' && this.token === undefined) {
      return { kind: 'open' };
    }
    if (this.auth === undefined) {
      return this.token === undefined ? { kind: 'open' } : null;
    }
    const token = this.sessionToken(req);
    if (token === undefined) return null;
    const session = await this.auth.service.resolve(token);
    if (session === undefined) return null;
    const requiredScope = this.scopeForRequest(req);
    if (requiredScope !== undefined && !hasScope(session.principal, requiredScope)) {
      return {
        kind: 'denied',
        error: new AuthError('scope_denied', `session lacks required scope '${requiredScope}'`, 403),
      };
    }
    return { kind: 'session', token, session };
  }

  /**
   * Keep read and write capabilities distinct.  A read scope must never
   * silently authorize receipt submission or lifecycle mutations; callers
   * that want both must grant both explicitly.  `requiredScope: null` is the
   * backwards-compatible escape hatch for a host that owns its full policy.
   */
  private scopeForRequest(req: IncomingMessage): string | undefined {
    if (this.auth?.requiredScope === null) return undefined;
    if (req.method === 'GET') return this.auth?.requiredScope ?? 'artifact:read';
    return this.auth?.requiredWriteScope === null ? undefined : this.auth?.requiredWriteScope ?? 'artifact:execute';
  }

  private async sessionAuth(req: IncomingMessage): Promise<RequestAuth | null> {
    if (this.auth === undefined) return null;
    const token = this.sessionToken(req);
    if (token === undefined) return null;
    const session = await this.auth.service.resolve(token);
    return session === undefined ? null : { kind: 'session', token, session };
  }

  private async handleAuthExchange(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.auth === undefined) {
      sendJSON(res, 501, { error: { code: 'not_implemented', message: 'CatsCo session auth is not configured' } });
      return;
    }
    if (this.token !== undefined && !this.pairingAuthorized(req)) {
      sendJSON(res, 401, { error: { code: 'unauthorized', message: 'pairing token required for auth exchange' } });
      return;
    }
    const userToken = this.catsCoUserToken(req);
    if (userToken === undefined) {
      sendJSON(res, 400, {
        error: {
          code: 'invalid_request',
          message: 'provide the CatsCo user JWT via X-CatsCo-User-Token or Authorization: CatsCo <token>',
        },
      });
      return;
    }
    try {
      const result = await this.auth.service.exchange(userToken);
      this.setSessionCookie(res, result.session);
      sendJSON(res, 200, {
        protocol_version: result.session.protocol_version,
        authenticated: true,
        principal: result.principal,
        created_at: result.session.created_at,
        expires_at: result.session.expires_at,
      });
    } catch (error) {
      this.sendError(res, error);
    }
  }

  private async handleAuthSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await this.sessionAuth(req);
    if (auth === null || auth.kind !== 'session') {
      sendJSON(res, 401, { error: { code: 'unauthorized', message: 'no active Artifact session' } });
      return;
    }
    const session = auth.session;
    sendJSON(res, 200, {
      authenticated: true,
      ...publicSession(session),
    });
  }

  private async handleAuthLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = this.sessionToken(req);
    if (token !== undefined && this.auth !== undefined) await this.auth.service.revoke(token);
    this.clearSessionCookie(res);
    sendJSON(res, 200, { ok: true });
  }

  private setSessionCookie(res: ServerResponse, session: ArtifactSession): void {
    const expires = Date.parse(session.expires_at);
    const created = Date.parse(session.created_at);
    // Derive the relative lifetime from the session timestamps rather than
    // the process wall clock. This keeps injected/frozen clocks from issuing
    // a cookie that is immediately considered expired by the browser.
    const lifetime = Number.isFinite(expires) && Number.isFinite(created) ? expires - created : 1_000;
    const maxAge = Math.max(1, Math.ceil(lifetime / 1000));
    const secure = this.auth?.secureCookie === true ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${this.authCookieName}=${encodeURIComponent(session.session_id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
    );
  }

  private clearSessionCookie(res: ServerResponse): void {
    res.setHeader(
      'Set-Cookie',
      `${this.authCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    );
  }

  private async handleSubmit(req: IncomingMessage, res: ServerResponse, auth: RequestAuth | null): Promise<void> {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      sendJSON(res, 400, { error: { code: 'invalid_request', message: 'body must be valid JSON' } });
      return;
    }
    if (!isRecord(body)) {
      sendJSON(res, 400, { error: { code: 'invalid_request', message: 'body must be an object' } });
      return;
    }
    if (!isRecord(body['bundle']) || !hasMinimalBundle(body['bundle'])) {
      sendJSON(res, 400, {
        error: {
          code: 'invalid_request',
          message: 'body.bundle must be a valid ContextBundle (bundle_id, session_id, artifact_id, revision, selections, intent)',
        },
      });
      return;
    }
    if (auth?.kind === 'session' && body['bundle']['actor_id'] !== auth.session.principal.actor_id) {
      sendJSON(res, 403, {
        error: {
          code: 'actor_mismatch',
          message: 'bundle.actor_id must match the authenticated Artifact session actor',
        },
      });
      return;
    }
    if (
      body['idempotency_key'] !== undefined &&
      (typeof body['idempotency_key'] !== 'string' || body['idempotency_key'].trim() === '' || body['idempotency_key'].length > 256)
    ) {
      sendJSON(res, 400, { error: { code: 'invalid_request', message: 'idempotency_key must be a non-empty string (max 256 chars)' } });
      return;
    }
    if (
      body['ttl_ms'] !== undefined &&
      (typeof body['ttl_ms'] !== 'number' || !Number.isSafeInteger(body['ttl_ms']) || body['ttl_ms'] < 0)
    ) {
      sendJSON(res, 400, { error: { code: 'invalid_request', message: 'ttl_ms must be a non-negative integer' } });
      return;
    }
    if (body['mode'] !== undefined && !isBridgeMode(body['mode'])) {
      sendJSON(res, 400, { error: { code: 'invalid_request', message: `unsupported bridge mode '${String(body['mode'])}'` } });
      return;
    }
    const request: BridgeSubmitRequest = {
      bundle: body['bundle'] as BridgeSubmitRequest['bundle'],
      ...(typeof body['idempotency_key'] === 'string' ? { idempotency_key: body['idempotency_key'] } : {}),
      ...(typeof body['ttl_ms'] === 'number' ? { ttl_ms: body['ttl_ms'] } : {}),
      ...(isBridgeMode(body['mode']) ? { mode: body['mode'] } : {}),
    };
    const receipt = await this.store.submit(request);
    await this.emit(receipt);
    sendJSON(res, 200, receipt);
  }

  private async handleMutation(
    req: IncomingMessage,
    res: ServerResponse,
    bundleId: string,
    op: 'ack' | 'resume' | 'complete' | 'reject',
    auth: RequestAuth | null,
  ): Promise<void> {
    if (!(await this.canAccessBundle(bundleId, auth))) {
      sendJSON(res, 404, { error: { code: 'not_found', message: `no bundle '${bundleId}'` } });
      return;
    }
    let reason = 'policy';
    if (op === 'reject') {
      const raw = await readBody(req);
      if (raw.trim() !== '') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          sendJSON(res, 400, { error: { code: 'invalid_request', message: 'reject body must be valid JSON' } });
          return;
        }
        if (!isRecord(parsed) || (parsed['reason'] !== undefined && !nonEmptyString(parsed['reason']))) {
          sendJSON(res, 400, { error: { code: 'invalid_request', message: 'reject body must contain an optional non-empty reason' } });
          return;
        }
        if (typeof parsed['reason'] === 'string') reason = parsed['reason'];
      }
    }
    let receipt: BridgeReceipt;
    switch (op) {
      case 'ack':
        receipt = await this.store.ack(bundleId);
        break;
      case 'resume':
        receipt = await this.store.resume(bundleId);
        break;
      case 'complete':
        receipt = await this.store.complete(bundleId);
        break;
      case 'reject':
        receipt = await this.store.reject(bundleId, reason);
        break;
    }
    await this.emit(receipt);
    sendJSON(res, 200, receipt);
  }

  private async handleWatch(
    req: IncomingMessage,
    res: ServerResponse,
    state: string | null,
    auth: RequestAuth | null,
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(`: connected\n\n`);
    const filter = (state ?? undefined) as BridgeReceipt['state'] | undefined;
    const watcher: ReceiptWatcher = {
      res,
      ...(filter !== undefined ? { state: filter } : {}),
      ...sessionActor(auth),
      queue: Promise.resolve(),
    };
    this.watchers.set(res, watcher);
    req.on('close', () => this.watchers.delete(res));
    // Register before replay so a submission that arrives during the store
    // read is not lost. The client can safely dedupe an identical snapshot
    // receipt by bundle/receipt id.
    const receipts = await this.visibleReceipts(filter, auth);
    const snapshot = filter !== undefined ? receipts.filter((r) => r.state === filter) : receipts;
    for (const receipt of snapshot) {
      if (responseClosed(res)) return;
      if (!(await this.receiptVisible(watcher, receipt))) continue;
      writeSSE(res, { type: 'receipt', receipt });
    }
  }

  /**
   * AG-UI-compatible projection stream.  This is intentionally a GET/SSE
   * subscription rather than an Agent runtime endpoint: the bridge projects
   * already-recorded ContextBundle receipts, and an external Agent may still
   * consume the ordinary `artifactctl context` CLI.
   */
  private async handleAgUiWatch(
    req: IncomingMessage,
    res: ServerResponse,
    state: string | null,
    bundleId: string | undefined,
    includeContext: boolean,
    auth: RequestAuth | null,
  ): Promise<void> {
    if (sessionActor(auth).actorId !== undefined && typeof this.store.getBundle !== 'function') {
      // Actor-scoped projections need the payload to establish ownership. A
      // thin store cannot safely serve even compact receipt events here.
      sendJSON(res, 501, {
        error: { code: 'not_implemented', message: 'session-scoped AG-UI watch requires a store with context payloads' },
      });
      return;
    }
    if (includeContext && typeof this.store.getBundle !== 'function') {
      sendJSON(res, 501, {
        error: { code: 'not_implemented', message: 'this bridge store does not expose context payloads' },
      });
      return;
    }
    const filter = (state ?? undefined) as BridgeReceiptState | undefined;
    // Take the actor-filtered initial snapshot before committing the HTTP
    // response to SSE. If the context store cannot establish ownership, the
    // normal route error handler can still return a clean JSON error rather
    // than corrupting an already-open stream.
    const initialReceipts = await this.visibleReceipts(filter, auth);
    if (responseClosed(res)) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Artifact-AX-Event-Projection': 'ag-ui-compatible',
    });
    res.write(`: connected\n\n`);
    const watcher: AgUiWatcher = {
      res,
      ...(filter !== undefined ? { state: filter } : {}),
      ...(bundleId !== undefined ? { bundleId } : {}),
      ...sessionActor(auth),
      includeContext,
      projector: new AgUiBridgeProjector({ includeContext }),
      queue: Promise.resolve(),
    };
    this.agUiWatchers.set(res, watcher);
    req.on('close', () => this.agUiWatchers.delete(res));

    try {
      await this.replayAgUi(watcher, initialReceipts);
      // Registering after the first lookup eliminates an error-after-headers
      // path, but creates a tiny snapshot-to-registration gap. Re-read once
      // after registration to close that gap. The projector fingerprints
      // receipt state, so unchanged rows do not become duplicate AG-UI
      // events.
      await this.replayAgUi(watcher, await this.visibleReceipts(filter, auth));
      await watcher.queue;
    } catch {
      // A later store failure cannot be rendered as JSON after SSE headers;
      // explicitly unregister and close the stream instead.
      this.agUiWatchers.delete(res);
      if (!responseClosed(res)) res.end();
    }
  }

  private async replayAgUi(watcher: AgUiWatcher, receipts: readonly BridgeReceipt[]): Promise<void> {
    for (const receipt of receipts) {
      if (responseClosed(watcher.res)) return;
      if (!this.matchesAgUi(watcher, receipt)) continue;
      await this.queueAgUi(watcher, receipt);
    }
  }

  private matchesAgUi(watcher: AgUiWatcher, receipt: BridgeReceipt): boolean {
    if (watcher.state !== undefined && receipt.state !== watcher.state) return false;
    return watcher.bundleId === undefined || receipt.bundle_id === watcher.bundleId;
  }

  private async queueAgUi(watcher: AgUiWatcher, receipt: BridgeReceipt): Promise<void> {
    // Stores are allowed to reuse/mutate receipt objects during a transition.
    // Capture the observed state before an async context lookup so a fast
    // second mutation cannot rewrite the event currently being serialized.
    const observed = { ...receipt };
    watcher.queue = watcher.queue.then(async () => {
      if (responseClosed(watcher.res) || !this.matchesAgUi(watcher, observed)) return;
      let bundle: ContextBundle | undefined;
      let contextLookupFailed = false;
      if (typeof this.store.getBundle === 'function') {
        // Context is only included when explicitly requested, but fetching the
        // bundle for the compact reference also gives a stable session/thread
        // identity to the projector.
        try {
          bundle = await this.store.getBundle(observed.bundle_id);
        } catch {
          // A thin/remote store may temporarily decline the payload lookup.
          // Pairing/open streams can still emit a compact receipt with a
          // deterministic fallback identity; session streams fail closed
          // below because ownership cannot be established.
          bundle = undefined;
          contextLookupFailed = true;
        }
      }
      // A session-scoped stream must never fall back to an unowned compact
      // receipt when ownership cannot be established. Pairing/open streams
      // have no actor boundary and may still project compactly.
      if (watcher.actorId !== undefined && (contextLookupFailed || bundle?.actor_id !== watcher.actorId)) return;
      const events = watcher.projector.project(observed, bundle);
      for (const event of events) {
        if (responseClosed(watcher.res)) return;
        writeAgUiSSE(watcher.res, event);
      }
    });
    // A failed context lookup must not poison subsequent events on this
    // connection. Session streams simply omit the unverified event; pairing
    // streams can still project compactly.
    watcher.queue = watcher.queue.catch(() => undefined);
    await watcher.queue;
  }

  private async emit(receipt: BridgeReceipt): Promise<void> {
    const observed = { ...receipt };
    for (const [res, watcher] of this.watchers) {
      if (res.writableEnded) {
        this.watchers.delete(res);
        continue;
      }
      if (watcher.state !== undefined && observed.state !== watcher.state) continue;
      watcher.queue = watcher.queue
        .then(async () => {
          if (responseClosed(res) || !(await this.receiptVisible(watcher, observed))) return;
          writeSSE(res, { type: 'receipt', receipt: observed });
        })
        .catch(() => undefined);
      await watcher.queue;
    }
    for (const watcher of this.agUiWatchers.values()) {
      if (!this.matchesAgUi(watcher, observed)) continue;
      await this.queueAgUi(watcher, observed);
    }
  }

  private async visibleReceipts(state: BridgeReceiptState | undefined, auth: RequestAuth | null): Promise<BridgeReceipt[]> {
    let receipts: BridgeReceipt[];
    try {
      receipts = await this.store.list(state);
    } catch {
      throw new BridgeError('store_unavailable', 'bridge receipt store is unavailable', 503);
    }
    const actorId = sessionActor(auth).actorId;
    if (actorId === undefined) return receipts;
    if (typeof this.store.getBundle !== 'function') {
      throw new BridgeError('not_implemented', 'session-scoped listing requires a store with context payloads', 501);
    }
    const visible: BridgeReceipt[] = [];
    for (const receipt of receipts) {
      let bundle: ContextBundle | undefined;
      try {
        bundle = await this.store.getBundle(receipt.bundle_id);
      } catch {
        throw new BridgeError('store_unavailable', 'bridge context store is unavailable', 503);
      }
      if (bundle?.actor_id === actorId) visible.push(receipt);
    }
    return visible;
  }

  private async authorizedBundle(bundleId: string, auth: RequestAuth | null): Promise<ContextBundle | undefined> {
    if (typeof this.store.getBundle !== 'function') {
      // Thin stores can still serve pairing/open callers; a session caller
      // cannot be authorized without reading the bundle's actor binding.
      if (sessionActor(auth).actorId !== undefined) {
        throw new BridgeError('not_implemented', 'session-scoped access requires a store with context payloads', 501);
      }
      return undefined;
    }
    const bundle = await this.store.getBundle(bundleId);
    const actorId = sessionActor(auth).actorId;
    if (actorId !== undefined && bundle?.actor_id !== actorId) return undefined;
    return bundle;
  }

  private async canAccessBundle(bundleId: string, auth: RequestAuth | null): Promise<boolean> {
    if (sessionActor(auth).actorId === undefined) return true;
    return (await this.authorizedBundle(bundleId, auth)) !== undefined;
  }

  private async receiptVisible(watcher: ReceiptWatcher, receipt: BridgeReceipt): Promise<boolean> {
    if (watcher.actorId === undefined) return true;
    if (typeof this.store.getBundle !== 'function') return false;
    const bundle = await this.store.getBundle(receipt.bundle_id);
    return bundle?.actor_id === watcher.actorId;
  }

  private sendError(res: ServerResponse, error: unknown): void {
    if (error instanceof AuthError) {
      sendJSON(res, error.status, {
        error: {
          code: error.code,
          message: error.message,
          ...(error.reason !== undefined ? { reason: error.reason } : {}),
        },
      });
      return;
    }
    if (error instanceof BridgeError) {
      sendJSON(res, error.status, { error: { code: error.code, message: error.message } });
      return;
    }
    sendJSON(res, 500, {
      error: { code: 'internal_error', message: error instanceof Error ? error.message : String(error) },
    });
  }

  private async sweepExpired(): Promise<void> {
    const expire = this.store.expireNow;
    if (typeof expire !== 'function') return;
    for (const receipt of await expire.call(this.store)) await this.emit(receipt);
  }
}

function sessionActor(auth: RequestAuth | null): { actorId?: string } {
  if (auth?.kind !== 'session') return {};
  return { actorId: auth.session.principal.actor_id };
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (header === undefined) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const raw = part.slice(separator + 1).trim();
    if (name === '') continue;
    try {
      cookies.set(name, decodeURIComponent(raw));
    } catch {
      // Ignore malformed cookie values; session resolution will fail closed.
    }
  }
  return cookies;
}

function secureEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]';
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isReceiptState(value: string): value is BridgeReceipt['state'] {
  return (
    value === 'accepted' ||
    value === 'queued' ||
    value === 'needs_confirm' ||
    value === 'acknowledged' ||
    value === 'completed' ||
    value === 'rejected' ||
    value === 'expired'
  );
}

function isBridgeMode(value: unknown): value is BridgeSubmitRequest['mode'] {
  return value === 'send' || value === 'queue' || value === 'confirm';
}
