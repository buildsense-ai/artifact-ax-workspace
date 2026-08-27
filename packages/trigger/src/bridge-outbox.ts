/**
 * BridgeOutbox: an `Outbox` implementation that delivers a ContextBundle to an
 * external Agent through the Agent Bridge HTTP API instead of a local mock.
 *
 * This keeps the SPA's transport honest: when a bridge is configured, bundles
 * leave the process through the bridge (`v1/submit`) and are tracked by an
 * explicit receipt state; otherwise the SPA uses `MockOutbox`. The bridge is
 * NOT a CatsCo chat send — it speaks the artifact bridge protocol only, so a
 * bridge endpoint can never be mistaken for a CatsCo `/api/messages/send`.
 */

import { type BridgeReceipt, type BridgeReceiptState } from './bridge.js';
import { type BridgeClient } from './bridge-client.js';
import { type ContextBundle } from './types.js';
import { type DeliveryReceipt, type Outbox } from './outbox.js';

export interface BridgeOutboxOptions {
  /** Bridge HTTP client (base URL + pairing token). */
  client: BridgeClient;
  /** Optional submit staging hint; defaults to a mapping of bundle.delivery. */
  mode?: 'send' | 'queue' | 'confirm';
  /** Thrown BridgeError is swallowed into an unsuccessful receipt by default. */
  failHard?: boolean;
}

export class BridgeOutbox implements Outbox {
  readonly label: string;
  private readonly client: BridgeClient;
  private readonly mode?: BridgeOutboxOptions['mode'];
  private readonly failHard: boolean;
  /** Local cache of receipts; the bridge deliberately does not echo bundles. */
  private readonly receiptStore = new Map<string, DeliveryReceipt>();

  constructor(options: BridgeOutboxOptions) {
    this.client = options.client;
    this.mode = options.mode;
    this.failHard = options.failHard ?? false;
    this.label = `bridge outbox → ${this.clientLabel()}`;
  }

  async send(bundle: ContextBundle): Promise<DeliveryReceipt> {
    let receipt: BridgeReceipt;
    try {
      receipt = await this.client.submit({ bundle, mode: this.mode });
    } catch (error) {
      if (this.failHard) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const failed: DeliveryReceipt = {
        ok: false,
        bundle_id: bundle.bundle_id,
        kind: 'rejected',
        message: `bridge submit failed: ${message}`,
      };
      this.receiptStore.set(bundle.bundle_id, failed);
      return failed;
    }
    const delivered: DeliveryReceipt = {
      ok: receipt.state !== 'rejected' && receipt.state !== 'expired',
      bundle_id: bundle.bundle_id,
      kind: receiptKind(receipt.state),
      message: receipt.message,
      ...(receipt.receipt_id ? { receipt_id: receipt.receipt_id } : {}),
      ...(receipt.state ? { bridged_state: receipt.state } : {}),
    };
    this.receiptStore.set(bundle.bundle_id, delivered);
    return delivered;
  }

  has(bundleId: string): boolean {
    return this.receiptStore.has(bundleId);
  }

  list(): ContextBundle[] {
    // The bridge tracks receipts separately from its authorized context-fetch
    // route. Returning full bundles here would make an Outbox pretend to own a
    // remote payload, so the SPA uses `listReceipts()` for bridge mode.
    return [];
  }

  /** Receipts are safe to render locally without putting full bundles on wire. */
  listReceipts(): DeliveryReceipt[] {
    return [...this.receiptStore.values()];
  }

  /** Fold a receipt received from the bridge watch stream into the local view. */
  ingest(receipt: BridgeReceipt): void {
    const delivered: DeliveryReceipt = {
      ok: receipt.state !== 'rejected' && receipt.state !== 'expired',
      bundle_id: receipt.bundle_id,
      kind: receiptKind(receipt.state),
      message: receipt.message,
      ...(receipt.receipt_id ? { receipt_id: receipt.receipt_id } : {}),
      bridged_state: receipt.state,
    };
    this.receiptStore.set(receipt.bundle_id, delivered);
  }

  private clientLabel(): string {
    // Expose only the origin, never a token accidentally embedded in a query.
    try {
      return new URL(this.client.baseURL).origin;
    } catch {
      return this.client.baseURL.split('?')[0] ?? this.client.baseURL;
    }
  }
}

function receiptKind(state: BridgeReceiptState): DeliveryReceipt['kind'] {
  switch (state) {
    case 'accepted':
      return 'accepted';
    case 'queued':
      return 'queued';
    case 'needs_confirm':
      return 'needs_confirm';
    case 'acknowledged':
      return 'acknowledged';
    case 'completed':
      return 'completed';
    case 'rejected':
      return 'rejected';
    case 'expired':
      return 'expired';
  }
}
