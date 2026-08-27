import {
  type ActorInput,
  type Approval,
  type AxGateway,
  type CommandResult,
  type Event,
  type Manifest,
  type Projection,
  ContractError,
} from '@artifact-ax/contract';
import { ArtifactService } from '@artifact-ax/domain';
import { LESSON_REPORT_MEMBERS, LESSON_REPORT_SPEC } from '@artifact-ax/lesson-report';
import { HttpAxGateway } from '@artifact-ax/catsco-adapter';
import { ArtifactAuthClient } from '@artifact-ax/auth';
import { BridgeClient } from '@artifact-ax/trigger';

/**
 * Transport selection: when an Artifact node is reachable (same origin or
 * AX_API_BASE), the SPA speaks HTTP. Otherwise it falls back to an in-process
 * mock domain service — the SPA stays usable without any Agent or service,
 * which is the point of the "no runtime required" boundary.
 *
 * External Agent Bridge: when a `bridge` base URL is configured (`?bridge=`),
 * context bundles are delivered through the bridge (BridgeOutbox) instead of
 * the local MockOutbox. This is deliberately opt-in; the SPA is honest that
 * the bridge speaks the artifact.ax.bridge.v1 protocol, never a CatsCo chat
 * send, and the browser never spawns a process.
 */

export interface AppConfig {
  workspaceId: string;
  artifactId: string;
  actor: ActorInput;
  transports: { label: string; http: boolean };
  /** External Agent Bridge base URL, when configured (?bridge=<url>). */
  bridgeUrl: string | null;
  /** Optional local-dev pairing token (?bridge_token= or env). */
  bridgeToken?: string;
  /** Use the optional HttpOnly Artifact session instead of a pairing token. */
  bridgeSession: boolean;
}

const ACTOR_OPTIONS: ActorInput[] = [
  { id: 'agent_440', type: 'agent', name: 'Agent (builder+operator)' },
  { id: 'human_teacher', type: 'human', name: 'Teacher (owner)' },
  { id: 'human_reviewer', type: 'human', name: 'Reviewer' },
];

function actorFromParam(value: string | null): ActorInput {
  const match = ACTOR_OPTIONS.find((a) => a.id === value);
  return match ?? ACTOR_OPTIONS[0]!;
}

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

function apiBaseFromLocation(): string {
  const explicit = params().get('ax_base');
  if (explicit) return explicit.replace(/\/+$/, '');
  // When served by the demo node (/by-agent/440/lesson-report/latest/), the
  // AX API lives at the same origin under /ax/v1. The client appends the
  // /ax/v1 prefix itself, so the base is the server origin only.
  return window.location.origin;
}

function bridgeFromParams(): { url: string | null; token?: string } {
  const url = params().get('bridge');
  const token = params().get('bridge_token') ?? undefined;
  return { url, ...(token ? { token } : {}) };
}

export function resolveConfig(): AppConfig {
  const query = params();
  const forceMock = query.get('mock') === '1';
  const forceHttp = query.get('http') === '1';
  const artist = actorFromParam(query.get('as'));
  const bridge = bridgeFromParams();
  const config: AppConfig = {
    workspaceId: query.get('workspace') ?? 'ws_demo',
    artifactId: query.get('artifact') ?? 'lesson-report',
    actor: artist,
    transports: { label: '', http: false },
    bridgeUrl: bridge.url,
    bridgeSession: params().get('bridge_session') === '1' || params().get('bridge_auth') === '1',
    ...(bridge.token ? { bridgeToken: bridge.token } : {}),
  };
  if (forceMock) {
    config.transports = { label: 'in-process mock transport', http: false };
    return config;
  }
  if (forceHttp) {
    config.transports = { label: `HTTP gateway (${apiBaseFromLocation()})`, http: true };
    return config;
  }
  config.transports = { label: `HTTP gateway (${apiBaseFromLocation()})`, http: true };
  return config;
}

export function createBridgeClient(config: AppConfig): BridgeClient | null {
  if (!config.bridgeUrl) return null;
  return new BridgeClient({
    baseURL: config.bridgeUrl,
    ...(config.bridgeToken ? { token: config.bridgeToken } : {}),
    ...(config.bridgeSession ? { credentials: 'include' } : {}),
  });
}

/**
 * Browser-safe session client for hosts that opt into the transitional auth
 * adapter (`?bridge_session=1`). It never exposes the HttpOnly cookie value.
 */
export function createAuthClient(config: AppConfig): ArtifactAuthClient | null {
  if (!config.bridgeUrl || !config.bridgeSession) return null;
  return new ArtifactAuthClient({ baseURL: config.bridgeUrl, credentials: 'include' });
}

/** Populate the config actor from an already-exchanged HttpOnly session. */
export async function hydrateSessionActor(config: AppConfig): Promise<boolean> {
  const authClient = createAuthClient(config);
  if (!authClient) return false;
  try {
    const session = await authClient.current();
    if (!session) return false;
    config.actor = {
      id: session.principal.actor_id,
      type: session.principal.actor_type,
      ...(session.principal.display_name ? { name: session.principal.display_name } : {}),
    };
    return true;
  } catch {
    return false;
  }
}

export async function createGateway(config: AppConfig): Promise<{ gateway: AxGateway; transport: string }> {
  await hydrateSessionActor(config);
  if (!config.transports.http) {
    const members = [...LESSON_REPORT_MEMBERS];
    if (!members.some((member) => member.actor_id === config.actor.id)) {
      // A real host supplies its own workspace policy. The local mock only
      // needs a read-visible placeholder so an authenticated session does not
      // make the standalone demo unusable.
      members.push({ actor_id: config.actor.id, roles: ['observer'] });
    }
    const service = new ArtifactService({
      specs: [LESSON_REPORT_SPEC],
      workspaces: [{ id: 'ws_demo', members }],
    });
    return { gateway: service, transport: config.transports.label };
  }
  const base = apiBaseFromLocation();
  const gateway = new HttpAxGateway(base, config.actor);
  // Probe once; if the node is absent, fall back to the mock transport so a
  // static demo never bricks.
  try {
    await gateway.describe({
      workspace_id: config.workspaceId,
      artifact_id: config.artifactId,
      actor: config.actor,
    });
    return { gateway, transport: `HTTP gateway (${base})` };
  } catch (error) {
    if (error instanceof ContractError && (error.status === 404 || error.code === 'artifact_not_found')) {
      throw error; // real node, unknown artifact — do not mask with mock
    }
    (window as unknown as Record<string, unknown>)['__AX_PROBE_ERROR'] = error instanceof Error ? error.message : String(error);
    const mock = new ArtifactService({
      specs: [LESSON_REPORT_SPEC],
      workspaces: [{ id: 'ws_demo', members: [...LESSON_REPORT_MEMBERS] }],
    });
    return { gateway: mock, transport: 'in-process mock transport (node unreachable)' };
  }
}

export { ACTOR_OPTIONS };

export type { ActorInput, AxGateway, CommandResult, Event, Manifest, Projection, Approval };
