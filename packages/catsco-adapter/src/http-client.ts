import {
  type ActorInput,
  type ApprovalResolutionResult,
  type AxGateway,
  type CommandInput,
  type CommandResult,
  type CreateDraftRequest,
  type DescribeRequest,
  type Draft,
  type InspectRequest,
  type Manifest,
  type Projection,
  type PublishDraftRequest,
  type PublishResult,
  type ResolveApprovalRequest,
  type ValidateDraftRequest,
  type WatchEnvelope,
  type WatchRequest,
  ContractError,
  isRecord,
} from '@artifact-ax/contract';

/**
 * Fetch-based AX gateway client. Browser-safe (uses global fetch) and used by
 * artifactctl and the demo SPA when an Artifact node is reachable.
 */
export class HttpAxGateway implements AxGateway {
  constructor(
    private readonly baseURL: string,
    private readonly defaultActor?: ActorInput,
    private readonly fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  async describe(req: DescribeRequest): Promise<Manifest> {
    return this.httpGet(
      '/ax/v1/describe',
      { workspace_id: req.workspace_id, artifact_id: req.artifact_id },
      { actor: req.actor },
    ) as Promise<Manifest>;
  }

  async inspect(req: InspectRequest): Promise<Projection> {
    const params: Record<string, string> = {
      workspace_id: req.workspace_id,
      artifact_id: req.artifact_id,
    };
    if (req.version !== undefined) params.version = String(req.version);
    if (req.cursor !== undefined) params.cursor = String(req.cursor);
    if (req.max_events !== undefined) params.max_events = String(req.max_events);
    if (req.region !== undefined) params.region = req.region;
    return this.httpGet('/ax/v1/inspect', params, { actor: req.actor }) as Promise<Projection>;
  }

  async apply(cmd: CommandInput): Promise<CommandResult> {
    return this.httpPost('/ax/v1/apply', cmd as unknown as Record<string, unknown>) as Promise<CommandResult>;
  }

  async createDraft(req: CreateDraftRequest): Promise<Draft> {
    return this.httpPost('/ax/v1/drafts', req as unknown as Record<string, unknown>) as Promise<Draft>;
  }

  async validateDraft(req: ValidateDraftRequest): Promise<Draft> {
    return this.httpPost('/ax/v1/drafts/validate', req as unknown as Record<string, unknown>) as Promise<Draft>;
  }

  async publish(req: PublishDraftRequest): Promise<PublishResult> {
    return this.httpPost('/ax/v1/publish', req as unknown as Record<string, unknown>) as Promise<PublishResult>;
  }

  async resolveApproval(req: ResolveApprovalRequest): Promise<ApprovalResolutionResult> {
    return this.httpPost('/ax/v1/approvals/resolve', req as unknown as Record<string, unknown>) as Promise<ApprovalResolutionResult>;
  }

  async *watch(req: WatchRequest): AsyncIterable<WatchEnvelope> {
    const params = new URLSearchParams({ workspace_id: req.workspace_id, artifact_id: req.artifact_id });
    if (req.cursor !== undefined) params.set('cursor', String(req.cursor));
    if (req.timeout_ms !== undefined) params.set('timeout_ms', String(req.timeout_ms));
    if (req.max_events !== undefined) params.set('max_events', String(req.max_events));
    for (const type of req.include_types ?? []) params.append('include_type', type);
    if (req.actor) {
      params.set('actor_id', req.actor.id);
      if (req.actor.type !== undefined) params.set('actor_type', req.actor.type);
    }

    const actor = req.actor ?? this.defaultActor;
    const response = await this.fetchImpl(`${this.baseURL}/ax/v1/watch?${params}`, {
      headers: {
        Accept: 'text/event-stream',
        ...(actor ? { 'X-AX-Actor': JSON.stringify(actor) } : {}),
      },
    });
    if (!response.ok || !response.body) {
      throw new ContractError('watch_failed', `watch stream failed: HTTP ${response.status}`, response.status);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const payload = JSON.parse(line.slice(6)) as WatchEnvelope;
            if (payload.kind === 'event') yield payload;
            else yield payload;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    yield { kind: 'done', reason: 'closed' };
  }

  private async httpGet(path: string, params: Record<string, string>, opts?: { actor?: ActorInput }): Promise<unknown> {
    const search = new URLSearchParams(params).toString();
    const query = search ? `?${search}` : '';
    const response = await this.fetchImpl(`${this.baseURL}${path}${query}`, {
      headers: {
        Accept: 'application/json',
        ...(opts?.actor ?? this.defaultActor ? { 'X-AX-Actor': JSON.stringify(opts?.actor ?? this.defaultActor) } : {}),
      },
    });
    return this.parseResponse(response);
  }

  private async httpPost(path: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseURL}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(this.defaultActor ? { 'X-AX-Actor': JSON.stringify(this.defaultActor) } : {}),
      },
      body: JSON.stringify(body),
    });
    return this.parseResponse(response);
  }

  private async parseResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text === '' ? null : JSON.parse(text);
    } catch {
      throw new ContractError('invalid_response', `non-JSON response (HTTP ${response.status})`, response.status);
    }
    if (!response.ok) {
      if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === 'string') {
        throw new ContractError(payload.error.code, String(payload.error.message ?? response.statusText), response.status);
      }
      throw new ContractError('http_error', `HTTP ${response.status}`, response.status);
    }
    return payload;
  }
}