import {
  FRAME_BRIDGE_NONCE_PARAM,
  FRAME_BRIDGE_REQUEST_TYPE,
  buildFrameBridgeReady,
  newRequestId,
} from '@artifact-ax/contract';
import type { RuntimeChannel } from './types.js';

/**
 * Multiplexed page↔host channel.
 *
 * Inbound envelopes may arrive on `window` postMessage or on the transferred
 * bridge MessagePort; outbound replies go back on the channel a message
 * arrived on, and page-initiated envelopes prefer the bridge port when a
 * handshake bound one (opaque frames cannot use the WindowProxy channel).
 */

export interface MultiplexedChannel extends RuntimeChannel {
  /** The bridge port when the opaque-frame handshake bound one. */
  readonly bridgePort: MessagePort | null;
  /** The nonce consumed from the URL fragment, when present. */
  readonly nonce: string | null;
}

export interface ChannelOptions {
  window?: Window;
  /** Explicit parent origin for outbound postMessage; '*' for opaque frames. */
  parentOrigin?: string;
  /** Fail-safe when the page runs standalone (not embedded). */
  standalone?: boolean;
}

/** Read and strip the one-time bridge nonce from the URL fragment. */
export function consumeBridgeNonce(win: Window): string | null {
  const raw = win.location.hash.replace(/^#/, '');
  if (!raw) return null;
  const parts = raw.split('&');
  let nonce: string | null = null;
  const kept: string[] = [];
  for (const part of parts) {
    if (part.startsWith(`${FRAME_BRIDGE_NONCE_PARAM}=`)) {
      nonce = decodeURIComponent(part.slice(FRAME_BRIDGE_NONCE_PARAM.length + 1));
    } else {
      kept.push(part);
    }
  }
  if (nonce !== null) {
    const next = kept.length > 0 ? `#${kept.join('&')}` : win.location.pathname + win.location.search;
    try {
      win.history.replaceState(null, '', next);
    } catch {
      // A stripping failure never blocks the handshake; the nonce is still valid.
    }
  }
  return nonce;
}

/**
 * Create the multiplexed channel. The returned channel starts listening for
 * the frame-bridge request immediately; callers usually pass it straight to
 * `openRuntimeSession`, which completes the handshake.
 */
export function createChannel(options: ChannelOptions = {}): MultiplexedChannel {
  const win = options.window ?? window;
  const parentOrigin = options.parentOrigin ?? '*';
  const handlers = new Set<(message: unknown) => void>();
  let bridgePort: MessagePort | null = null;
  let closed = false;

  const emit = (message: unknown) => {
    for (const handler of [...handlers]) {
      try {
        handler(message);
      } catch {
        // One bad listener must not starve the others.
      }
    }
  };

  const onWindowMessage = (event: MessageEvent) => {
    if (closed || !event.data || typeof event.data !== 'object') return;
    const data = event.data as Record<string, unknown>;
    // The frame-bridge request is handled by openRuntimeSession through the
    // same listener list; everything flows through `emit`.
    emit(data);
    // Bind a transferred port when the host sends the handshake.
    const port = event.ports?.[0];
    if (data.type === FRAME_BRIDGE_REQUEST_TYPE && port && !bridgePort) {
      bridgePort = port;
      port.onmessage = (portEvent) => emit(portEvent.data);
      port.start?.();
    }
  };
  win.addEventListener('message', onWindowMessage);

  const channel: MultiplexedChannel = {
    get bridgePort() {
      return bridgePort;
    },
    nonce: consumeBridgeNonce(win),
    send(message: unknown) {
      if (closed) return;
      if (bridgePort) {
        try {
          bridgePort.postMessage(message);
          return;
        } catch {
          // Fall back to the window channel below.
        }
      }
      try {
        win.parent.postMessage(message, parentOrigin);
      } catch {
        // Standalone pages have no host; sends are dropped.
      }
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {
      if (closed) return;
      closed = true;
      win.removeEventListener('message', onWindowMessage);
      try {
        bridgePort?.close?.();
      } catch {
        // Already detached.
      }
      handlers.clear();
    },
  };
  return channel;
}

/**
 * Answer the opaque frame-bridge handshake. Resolves once a READY reply has
 * been posted on the transferred port, or immediately when no nonce exists
 * (cross-origin frame or standalone page — the host skips the handshake).
 */
export function answerFrameBridge(channel: MultiplexedChannel, timeoutMs = 3000): Promise<boolean> {
  if (!channel.nonce) return Promise.resolve(false);
  const nonce = channel.nonce;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      off();
      resolve(ok);
    };
    const off = channel.onMessage((message) => {
      const data = message as Record<string, unknown>;
      if (data?.type === FRAME_BRIDGE_REQUEST_TYPE && channel.bridgePort) {
        channel.bridgePort.postMessage(buildFrameBridgeReady(nonce, newRequestId('brg')));
        finish(true);
      }
    });
    setTimeout(() => finish(false), timeoutMs);
  });
}
