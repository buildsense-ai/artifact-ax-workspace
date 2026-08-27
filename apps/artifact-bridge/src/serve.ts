/**
 * artifact-bridge — external Agent Bridge server (loopback HTTP).
 *
 * Receives ContextBundles from the SPA and tracks them through explicit
 * receipt states for an external Agent CLI to pull / ack / resume.
 *
 * State defaults to in-memory. Pass --store-file <path> (or set
 * AX_BRIDGE_STORE_FILE) to persist receipts to one atomic JSON file and
 * recover them across restarts (JsonFileBridgeStore).
 *
 * Usage:
 *   pnpm exec tsx apps/artifact-bridge/src/serve.ts [--port 8788] [--token <pairing-token>] [--store-file <path>]
 *     [--catsco-account-url <url>] [--catsco-service-token <token>]
 *
 * Env: AX_BRIDGE_PORT, AX_BRIDGE_TOKEN, AX_BRIDGE_HOST, AX_BRIDGE_STORE_FILE,
 * CATSCO_ACCOUNT_CENTER_URL, CATSCO_ACCOUNT_SERVICE_TOKEN,
 * AX_BRIDGE_AUTH_SESSION_TTL_MS, AX_BRIDGE_AUTH_SCOPES
 */

import { parseArgs } from 'node:util';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCatsCoAuthAdapter } from './catsco-auth.js';
import { JsonFileBridgeStore } from './json-file-store.js';
import { ArtifactBridgeServer } from './server.js';

function value(argv: Record<string, unknown>, key: string, env: string | undefined, fallback: string): string {
  if (typeof argv[key] === 'string' && argv[key] !== '') return argv[key] as string;
  return env ?? fallback;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      token: { type: 'string' },
      host: { type: 'string' },
      'store-file': { type: 'string' },
      'catsco-account-url': { type: 'string' },
      'catsco-service-token': { type: 'string' },
      'auth-session-ttl-ms': { type: 'string' },
      'auth-scopes': { type: 'string' },
      'auth-secure-cookie': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (parsed.values['help']) {
    process.stdout.write(`artifact-bridge — external Agent Bridge (loopback HTTP)

Usage: artifact-bridge [--port <n>] [--token <pairing-token>] [--host <ip>] [--store-file <path>]
                       [--catsco-account-url <url>] [--catsco-service-token <token>]

  --port        listen port (default $AX_BRIDGE_PORT or 8788)
  --token       optional pairing token; when set, /v1/* requires:
                Authorization: Bearer <token>
                (default $AX_BRIDGE_TOKEN; loopback only, not production auth)
  --host        bind address (default 127.0.0.1; keep loopback)
  --store-file  persist receipts to an atomic JSON file and recover them on
                restart; omit for in-memory state (default $AX_BRIDGE_STORE_FILE)
  --catsco-account-url  enable transitional CatsCo account-center introspection
                        (default $CATSCO_ACCOUNT_CENTER_URL)
  --catsco-service-token server-only Service Token for introspection
                          (default $CATSCO_ACCOUNT_SERVICE_TOKEN)
  --auth-session-ttl-ms session lifetime, 1000..86400000 (default 900000)
  --auth-scopes comma-separated Artifact scopes (default artifact:read; add
                artifact:execute for bridge submission/lifecycle writes)
  --auth-secure-cookie add Secure to the HttpOnly session cookie

  Transitional CatsCo session auth is loopback-only; use native OAuth/OIDC at
  a public edge instead of binding this adapter to 0.0.0.0.

Protocol routes (artifact.ax.bridge.v1):
  POST /v1/submit                 submit a ContextBundle -> BridgeReceipt
  GET  /v1/bundles                list receipts [?state=<state>]
  GET  /v1/bundles/<id>           one receipt
  GET  /v1/bundles/<id>/context  full context (authorized receiver)
  POST /v1/bundles/<id>/ack       staged -> acknowledged
  POST /v1/bundles/<id>/resume    queued/accepted -> acknowledged
  POST /v1/bundles/<id>/complete  acknowledged -> completed
  POST /v1/bundles/<id>/reject    -> rejected {reason}
  POST /v1/auth/exchange          CatsCo JWT -> HttpOnly Artifact session
  GET  /v1/auth/session            current public session view
  POST /v1/auth/logout             revoke the current session
  GET  /v1/watch                  SSE stream of receipt changes [?state=<state>]
  GET  /v1/ag-ui/watch            AG-UI-compatible SSE projection [?state=<state>&bundle_id=<id>&include_context=1]
  GET  /v1/health                 protocol check
`);
    return;
  }

  const port = Number(value(parsed.values, 'port', process.env['AX_BRIDGE_PORT'], '8788'));
  const token = value(parsed.values, 'token', process.env['AX_BRIDGE_TOKEN'], '');
  const host = value(parsed.values, 'host', process.env['AX_BRIDGE_HOST'], '127.0.0.1');
  const storeFile = value(parsed.values, 'store-file', process.env['AX_BRIDGE_STORE_FILE'], '');
  const accountURL = value(parsed.values, 'catsco-account-url', process.env['CATSCO_ACCOUNT_CENTER_URL'], '');
  const serviceToken = value(parsed.values, 'catsco-service-token', process.env['CATSCO_ACCOUNT_SERVICE_TOKEN'], '');
  if ((accountURL === '') !== (serviceToken === '')) {
    throw new Error('configure both --catsco-account-url and --catsco-service-token to enable CatsCo session auth');
  }
  const auth = accountURL === ''
    ? undefined
    : {
        service: createCatsCoAuthAdapter({
          account_url: accountURL,
          service_token: serviceToken,
          session_ttl_ms: optionalInteger(
            parsed.values['auth-session-ttl-ms'],
            process.env['AX_BRIDGE_AUTH_SESSION_TTL_MS'],
            900_000,
          ),
          scopes: parseScopes(value(parsed.values, 'auth-scopes', process.env['AX_BRIDGE_AUTH_SCOPES'], 'artifact:read')),
        }),
        secureCookie: parsed.values['auth-secure-cookie'] === true || process.env['AX_BRIDGE_AUTH_SECURE_COOKIE'] === '1',
      };

  const store = storeFile === '' ? undefined : await JsonFileBridgeStore.open(storeFile);
  const server = new ArtifactBridgeServer({
    token: token === '' ? undefined : token,
    host,
    store,
    auth,
  });
  await server.listen(port);
  const actual = server.address()?.port ?? port;
  const state = store === undefined ? 'in-memory' : `durable json file (${storeFile})`;
  const authState = auth === undefined ? 'CatsCo session auth disabled' : 'CatsCo transitional session auth enabled';
  process.stdout.write(
    `artifact-bridge listening on http://${host}:${actual} (protocol artifact.ax.bridge.v1, token ${token ? 'set' : 'none'}, store ${state}, ${authState})\n`,
  );
  // Do not exit on success: the listening server keeps the event loop alive.
}

const isMain = (() => {
  try {
    return process.argv[1] != null && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

function optionalInteger(value: unknown, env: string | undefined, fallback: number): number {
  const raw = typeof value === 'string' && value !== '' ? value : env;
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error('auth session TTL must be an integer');
  return parsed;
}

function parseScopes(value: string): string[] {
  return [...new Set(value.split(',').map((scope) => scope.trim()).filter(Boolean))];
}
