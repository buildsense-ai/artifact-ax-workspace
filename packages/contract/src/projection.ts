import type { Actor, ActorInput } from './actor.js';
import type { Approval } from './approval.js';
import type { Event } from './event.js';
import type { Region } from './manifest.js';

/**
 * An inspection response exposes a bounded, current view of application
 * state. It carries version/revision, bounded region data, pending approvals,
 * and a cursor for recent events. The service caps event count so a large
 * document never lands in an Agent context window.
 */
export interface InspectRequest {
  workspace_id: string;
  artifact_id: string;
  actor: ActorInput;
  /** Optional pinned published version; defaults to latest. */
  version?: number;
  /** Resume cursor: only events with seq > cursor are returned. */
  cursor?: number;
  /** Default 50; negative means no cap (tests only). */
  max_events?: number;
  /** Restrict the projection to a single region. */
  region?: string;
}

export interface RegionProjection {
  region: Region;
  data: unknown;
  /** seq of the last event that changed this region, if any. */
  changed_seq?: number;
}

export interface Projection {
  contract_version: 'artifact.ax.v1';
  workspace_id: string;
  artifact_id: string;
  actor: Actor;
  version: number;
  revision: number;
  regions: RegionProjection[];
  pending_approvals: Approval[];
  events: Event[];
  /** Seq of the last event included; pass back as cursor to resume. */
  cursor: number;
}