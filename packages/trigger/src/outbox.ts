import { type ContextBundle } from './types.js';

export interface DeliveryReceipt {
  ok: boolean;
  bundle_id: string;
  kind: 'sent' | 'collected' | 'suggested' | 'queued' | 'needs_confirm' | 'stored'
    | 'accepted' | 'acknowledged' | 'completed' | 'rejected' | 'expired';
  message: string;
  /** Bridge receipt id when delivered through an external bridge. */
  receipt_id?: string;
  /** Bridge receipt state when delivered through an external bridge. */
  bridged_state?: string;
}

export interface Outbox {
  /** Honest human label for the transport (cats-company is never touched). */
  readonly label: string;
  /** Send / store a bundle idempotently by bundle_id. */
  send(bundle: ContextBundle): Promise<DeliveryReceipt>;
  has(bundleId: string): boolean;
  list(): ContextBundle[];
}

/**
 * Local, in-memory mock outbox. It never writes to cats-company: bundles are
 * stored here so the SPA can show one compact CatsCo-style message per bundle
 * and reference full payloads via `context_ref`. Delivery is idempotent by
 * bundle_id: re-sending the same bundle returns a "stored" receipt.
 */
export class MockOutbox implements Outbox {
  readonly label = 'mock outbox: local only, cats-company untouched';
  private readonly store = new Map<string, ContextBundle>();

  has(bundleId: string): boolean {
    return this.store.has(bundleId);
  }

  list(): ContextBundle[] {
    return [...this.store.values()];
  }

  async send(bundle: ContextBundle): Promise<DeliveryReceipt> {
    if (this.store.has(bundle.bundle_id)) {
      return {
        ok: true,
        bundle_id: bundle.bundle_id,
        kind: 'stored',
        message: `idempotent: ${bundle.bundle_id} already in mock outbox`,
      };
    }
    this.store.set(bundle.bundle_id, bundle);
    return {
      ok: true,
      bundle_id: bundle.bundle_id,
      kind: bundle.delivery === 'collecting' ? 'collected' : bundle.delivery,
      message: `stored ${bundle.bundle_id} in mock outbox with delivery=${bundle.delivery} (no cats-company write)`,
    };
  }
}
