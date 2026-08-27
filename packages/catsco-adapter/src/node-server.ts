import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import {
  type ActorInput,
  type CloudArtifactStatus,
  ContractError,
  asString,
  isRecord,
} from '@artifact-ax/contract';
import { type ArtifactService } from '@artifact-ax/domain';
import { artifactPublicURL, renderIndex, renderManagementList, renderOperation } from './render.js';

export interface ArtifactNodeServerOptions {
  service: ArtifactService;
  /** Public origin where artifact pages are served (used in index/management URLs). */
  publicBaseURL: string;
  /** Bearer token required by management routes; must be >= 32 chars like CatsCo. */
  managementToken: string;
  /** Directory containing the built SPA bundle, served at each artifact URL. */
  staticDir?: string;
  /** Management URL prefix, default /internal/artifacts (matches CatsCo default). */
  managementBasePath?: string;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

const ERROR_MESSAGES: Record<string, string> = {
  artifact_not_found: 'artifact not found',
  artifact_already_deleted: 'artifact is already deleted',
  artifact_not_deleted: 'artifact is not deleted',
  artifact_path_invalid: 'invalid artifact identifier',
  artifact_operation_conflict: 'artifact state changed; refresh and retry',
  artifact_status_invalid: 'invalid artifact list status',
  unauthorized: 'unauthorized',
  invalid_request: 'invalid request',
};

function sendJSON(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(payload));
}

/** Upstream error shape cats-company parses: {"error":{"code":...}}. */
function sendUpstreamError(res: ServerResponse, status: number, code: string): void {
  sendJSON(res, status, { error: { code, message: ERROR_MESSAGES[code] ?? code } });
}

function writeSSE(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/** Runtime AX request helpers -------------------------------------------------- */

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function actorFromRequest(req: IncomingMessage, query: URLSearchParams): ActorInput {
  const header = req.headers['x-ax-actor'];
  if (typeof header === 'string' && header.trim() !== '') {
    try {
      const parsed = JSON.parse(header) as unknown;
      if (!isRecord(parsed) || typeof parsed.id !== 'string') {
        throw new ContractError('invalid_request', 'X-AX-Actor must be a JSON object with an id');
      }
      return {
        id: parsed.id as string,
        ...(typeof parsed.type === 'string' ? { type: parsed.type as ActorInput['type'] } : {}),
        ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
        ...(typeof parsed.owner_id === 'string' ? { owner_id: parsed.owner_id } : {}),
      };
    } catch (error) {
      if (error instanceof ContractError) throw error;
      throw new ContractError('invalid_request', 'X-AX-Actor must be valid JSON');
    }
  }
  const id = query.get('actor_id');
  if (!id) throw new ContractError('invalid_request', 'missing actor (send X-AX-Actor or actor_id)');
  return { id, ...(query.get('actor_type') ? { type: query.get('actor_type') as ActorInput['type'] } : {}) };
}

function sendContractError(res: ServerResponse, error: unknown): void {
  if (error instanceof ContractError) {
    sendJSON(res, 400, {
      error: { code: error.code, message: error.message },
    });
    return;
  }
  sendJSON(res, 500, { error: { code: 'internal_error', message: error instanceof Error ? error.message : String(error) } });
}

/** The CatsCo-compatible Artifact node server (mock transport). */
export class ArtifactNodeServer {
  readonly options: ArtifactNodeServerOptions;
  private readonly server: Server;

  constructor(options: ArtifactNodeServerOptions) {
    if (options.managementToken.length < 32) {
      throw new ContractError('invalid_management_token', 'management token must be at least 32 characters');
    }
    this.options = options;
    this.server = createServer((req, res) => {
      void this.route(req, res).catch((error) => {
        sendContractError(res, error);
      });
    });
  }

  listen(port: number, host = '127.0.0.1'): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(port, host, () => resolve());
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  address(): { port: number } | null {
    const addr = this.server.address();
    if (addr && typeof addr === 'object') return { port: addr.port };
    return null;
  }

  private get service(): ArtifactService {
    return this.options.service;
  }

  private managementAuthorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    return header === `Bearer ${this.options.managementToken}`;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const query = url.searchParams;

    if (req.method === 'GET' && path === '/artifacts-index.json') {
      sendJSON(res, 200, renderIndex(this.service.exportArtifacts(), { publicBaseURL: this.options.publicBaseURL }));
      return;
    }

    if (this.isManagementPath(path)) {
      this.routeManagement(req, res, path, query);
      return;
    }

    if (path === '/ax/v1/describe' && req.method === 'GET') {
      const actor = actorFromRequest(req, query);
      const manifest = await this.service.describe({
        workspace_id: asString(query.get('workspace_id'), 'workspace_id'),
        artifact_id: asString(query.get('artifact_id'), 'artifact_id'),
        actor,
      });
      sendJSON(res, 200, manifest);
      return;
    }
    if (path === '/ax/v1/inspect' && req.method === 'GET') {
      const actor = actorFromRequest(req, query);
      const cursor = query.get('cursor');
      const maxEvents = query.get('max_events');
      const region = query.get('region');
      const version = query.get('version');
      const projection = await this.service.inspect({
        workspace_id: asString(query.get('workspace_id'), 'workspace_id'),
        artifact_id: asString(query.get('artifact_id'), 'artifact_id'),
        actor,
        ...(cursor !== null ? { cursor: Number(cursor) } : {}),
        ...(maxEvents !== null ? { max_events: Number(maxEvents) } : {}),
        ...(region !== null ? { region } : {}),
        ...(version !== null ? { version: Number(version) } : {}),
      });
      sendJSON(res, 200, projection);
      return;
    }
    if (path === '/ax/v1/apply' && req.method === 'POST') {
      await this.handleJsonPost(req, res, (body) =>
        this.service.apply({
          workspace_id: asString(body.workspace_id, 'workspace_id'),
          artifact_id: asString(body.artifact_id, 'artifact_id'),
          version: Number(body.version),
          base_revision: Number(body.base_revision),
          actor: body.actor as ActorInput,
          name: asString(body.name, 'name'),
          args: (body.args ?? {}) as Record<string, unknown>,
          ...(typeof body.command_id === 'string' ? { command_id: body.command_id } : { command_id: globalThis.crypto.randomUUID() }),
          ...(typeof body.idempotency_key === 'string' ? { idempotency_key: body.idempotency_key } : {}),
        }),
      );
      return;
    }
    if (path === '/ax/v1/drafts' && req.method === 'POST') {
      await this.handleJsonPost(req, res, (body) =>
        this.service.createDraft({
          workspace_id: asString(body.workspace_id, 'workspace_id'),
          artifact_id: asString(body.artifact_id, 'artifact_id'),
          builder: body.builder as ActorInput,
          change_set: body.change_set as never,
        }),
      );
      return;
    }
    if (path === '/ax/v1/drafts/validate' && req.method === 'POST') {
      await this.handleJsonPost(req, res, (body) =>
        this.service.validateDraft({
          workspace_id: asString(body.workspace_id, 'workspace_id'),
          artifact_id: asString(body.artifact_id, 'artifact_id'),
          draft_id: asString(body.draft_id, 'draft_id'),
          actor: body.actor as ActorInput,
        }),
      );
      return;
    }
    if (path === '/ax/v1/publish' && req.method === 'POST') {
      await this.handleJsonPost(req, res, (body) =>
        this.service.publish({
          workspace_id: asString(body.workspace_id, 'workspace_id'),
          artifact_id: asString(body.artifact_id, 'artifact_id'),
          draft_id: asString(body.draft_id, 'draft_id'),
          actor: body.actor as ActorInput,
          ...(typeof body.approval_id === 'string' ? { approval_id: body.approval_id } : {}),
          ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        }),
      );
      return;
    }
    if (path === '/ax/v1/approvals/resolve' && req.method === 'POST') {
      await this.handleJsonPost(req, res, (body) =>
        this.service.resolveApproval({
          workspace_id: asString(body.workspace_id, 'workspace_id'),
          artifact_id: asString(body.artifact_id, 'artifact_id'),
          approval_id: asString(body.approval_id, 'approval_id'),
          decision: body.decision as 'approved' | 'rejected',
          reviewer: body.reviewer as ActorInput,
          ...(typeof body.note === 'string' ? { note: body.note } : {}),
        }),
      );
      return;
    }
    if (path === '/ax/v1/watch' && req.method === 'GET') {
      await this.handleWatch(req, res, query);
      return;
    }

    if (path === '/') {
      sendJSON(res, 200, {
        name: 'artifact-ax node (mock transport)',
        contract: 'artifact.ax.v1 + cloud-artifacts compatibility',
        endpoints: {
          index: '/artifacts-index.json',
          management: '/internal/artifacts',
          ax: '/ax/v1/{describe,inspect,apply,watch,publish}',
          artifacts: this.service.exportArtifacts().map((a) => ({
            id: a.id,
            url: artifactPublicURL({ publicBaseURL: this.options.publicBaseURL }, a),
            sidecar: `${artifactPublicURL({ publicBaseURL: this.options.publicBaseURL }, a)}artifact.ax.json`,
          })),
        },
      });
      return;
    }

    if (this.options.staticDir && path.startsWith('/by-agent/')) {
      const match = /^\/by-agent\/(\d+)\/([^/]+)\/latest\/(.*)$/.exec(path);
      if (match) {
        const [, agentUID, artifactID] = match;
        if (artifactID === undefined) {
          sendUpstreamError(res, 404, 'artifact_not_found');
          return;
        }
        const artifact = this.service.exportArtifacts().find((a) => a.id === artifactID);
        if (artifact && artifact.agent_uid === agentUID) {
          if (path.endsWith('/artifact.ax.json')) {
            const manifest = this.service.getArtifactManifest(artifactID);
            if (manifest) {
              sendJSON(res, 200, { ...manifest, url: artifactPublicURL({ publicBaseURL: this.options.publicBaseURL }, artifact) });
              return;
            }
          }
          const relative = match[3] === undefined || match[3] === '' ? 'index.html' : match[3];
          await this.serveStatic(res, relative);
          return;
        }
      }
    }

    sendUpstreamError(res, 404, 'artifact_not_found');
  }

  private isManagementPath(path: string): boolean {
    const base = this.options.managementBasePath ?? '/internal/artifacts';
    const parent = base.endsWith('/artifacts') ? base.slice(0, -'/artifacts'.length) : base;
    return (
      path === base ||
      path.startsWith(base + '/') ||
      path.startsWith(`${parent}/agents/`) // CatsCo collection: <parent>/agents/<uid>/artifacts
    );
  }

  /** CatsCo management surface: list / delete / restore, agent-scoped or flat. */
  private async routeManagement(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
    if (!this.managementAuthorized(req)) {
      sendUpstreamError(res, 401, 'unauthorized');
      return;
    }
    const base = this.options.managementBasePath ?? '/internal/artifacts';
    const parent = base.endsWith('/artifacts') ? base.slice(0, -'/artifacts'.length) : base;
    const status = query.get('status') ?? 'active';

    // CatsCo derives agent collection URLs from the management base:
    //   <base>/agents/<uid>/artifacts          (list)
    //   <base>/agents/<uid>/artifacts/<id>     (delete)
    //   <base>/agents/<uid>/artifacts/<id>/restore
    const agentMatch = new RegExp(`^${escapeRegExp(parent)}/agents/(\\d+)/artifacts(?:/([^/]+))?(?:/(restore))?$`).exec(path);
    const flatMatch = new RegExp(`^${escapeRegExp(base)}(?:/([^/]+))?(?:/(restore))?$`).exec(path);

    if (agentMatch) {
      const agentUID = agentMatch[1];
      const artifactID = agentMatch[2];
      const restore = agentMatch[3];
      if (artifactID === undefined) {
        void this.handleManagedList(req, res, status, agentUID !== undefined ? Number(agentUID) : undefined);
        return;
      }
      const actor = await this.actorFromManagementBody(req);
      void this.handleAgentMutation(req, res, agentUID !== undefined ? Number(agentUID) : undefined, artifactID, restore ? 'restore' : 'delete', actor);
      return;
    }
    if (flatMatch) {
      const artifactID = flatMatch[1];
      const restore = flatMatch[2];
      if (artifactID === undefined) {
        void this.handleManagedList(req, res, status);
        return;
      }
      const actor = await this.actorFromManagementBody(req);
      void this.handleAgentMutation(req, res, undefined, artifactID, restore ? 'restore' : 'delete', actor);
      return;
    }
    sendUpstreamError(res, 404, 'artifact_not_found');
  }

  private async handleManagedList(req: IncomingMessage, res: ServerResponse, status: string, agentUID?: number): Promise<void> {
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' });
      sendUpstreamError(res, 405, 'invalid_request');
      return;
    }
    if (status !== 'active' && status !== 'deleted') {
      sendUpstreamError(res, 400, 'artifact_status_invalid');
      return;
    }
    sendJSON(
      res,
      200,
      renderManagementList(this.service.exportArtifacts(), status as CloudArtifactStatus, {
        publicBaseURL: this.options.publicBaseURL,
        ...(agentUID !== undefined ? { agentUID: String(agentUID) } : {}),
      }),
    );
  }

  private async handleAgentMutation(
    req: IncomingMessage,
    res: ServerResponse,
    agentUID: number | undefined,
    artifactID: string,
    op: 'delete' | 'restore',
    actor: ActorInput,
  ): Promise<void> {
    const expectedMethod = op === 'delete' ? 'DELETE' : 'POST';
    if (req.method !== expectedMethod) {
      sendUpstreamError(res, 405, 'invalid_request');
      return;
    }
    const artifact = this.service.exportArtifacts().find((a) => a.id === artifactID);
    if (!artifact) {
      sendUpstreamError(res, 404, 'artifact_not_found');
      return;
    }
    if (agentUID !== undefined && artifact.agent_uid !== String(agentUID)) {
      sendUpstreamError(res, 404, 'artifact_not_found');
      return;
    }
    try {
      const exported =
        op === 'delete'
          ? await this.service.softDeleteArtifact(this.workspaceFor(artifactID), artifactID, actor)
          : await this.service.restoreArtifact(this.workspaceFor(artifactID), artifactID, actor);
      sendJSON(res, 200, renderOperation(exported, { publicBaseURL: this.options.publicBaseURL }));
    } catch (error) {
      if (error instanceof ContractError) {
        sendUpstreamError(res, this.mappingStatus(error.code), error.code);
        return;
      }
      throw error;
    }
  }

  private workspaceFor(artifactID: string): string {
    const manifest = this.service.getArtifactManifest(artifactID);
    return manifest?.workspace_id ?? 'ws_demo';
  }

  private mappingStatus(code: string): number {
    switch (code) {
      case 'artifact_not_found':
        return 404;
      case 'artifact_already_deleted':
      case 'artifact_not_deleted':
        return 409;
      case 'artifact_operation_conflict':
        return 409;
      default:
        return 400;
    }
  }

  private async actorFromManagementBody(req: IncomingMessage): Promise<ActorInput> {
    const raw = await readBody(req);
    if (raw.trim() === '') return { id: 'system', type: 'system' };
    try {
      const payload = JSON.parse(raw) as Record<string, unknown>;
      const uid = String(payload['actor_uid'] ?? 'system');
      return { id: uid === 'system' ? 'system' : `human_${uid}`, type: 'human' };
    } catch {
      return { id: 'system', type: 'system' };
    }
  }

  private async handleJsonPost(req: IncomingMessage, res: ServerResponse, run: (body: Record<string, unknown>) => Promise<unknown> | unknown): Promise<void> {
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      sendUpstreamError(res, 400, 'invalid_request');
      return;
    }
    try {
      const result = await run(body);
      sendJSON(res, 200, result);
    } catch (error) {
      sendContractError(res, error);
    }
  }

  private async handleWatch(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void> {
    const actor = actorFromRequest(req, query);
    const workspaceId = asString(query.get('workspace_id'), 'workspace_id');
    const artifactId = asString(query.get('artifact_id'), 'artifact_id');
    const cursor = query.get('cursor');
    const timeoutMs = query.get('timeout_ms');
    const maxEvents = query.get('max_events');
    const includeTypes = query.getAll('include_type');
    await this.service.describe({ workspace_id: workspaceId, artifact_id: artifactId, actor }); // existence + actor surface
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(`: connected\n\n`);
    const request: Parameters<ArtifactService['watch']>[0] = {
      workspace_id: workspaceId,
      artifact_id: artifactId,
      ...(cursor !== null ? { cursor: Number(cursor) } : {}),
      ...(timeoutMs !== null ? { timeout_ms: Number(timeoutMs) } : {}),
      ...(maxEvents !== null ? { max_events: Number(maxEvents) } : {}),
      ...(includeTypes.length > 0 ? { include_types: includeTypes } : {}),
    };
    for await (const envelope of this.service.watch(request)) {
      if (res.writableEnded) break;
      writeSSE(res, envelope);
      if (envelope.kind === 'done') break;
    }
    res.end();
  }

  private async serveStatic(res: ServerResponse, relative: string): Promise<void> {
    const staticDir = this.options.staticDir!;
    const safe = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '');
    const filePath = join(staticDir, safe);
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error('not a file');
      const body = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': contentType(filePath),
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      sendUpstreamError(res, 404, 'artifact_not_found');
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}