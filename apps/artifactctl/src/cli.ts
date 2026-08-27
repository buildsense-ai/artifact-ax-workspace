import { parseArgs } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpAxGateway } from '@artifact-ax/catsco-adapter';
import {
  type ActorInput,
  type CommandInput,
  type Draft,
  type DraftChangeSet,
  newCommandId,
  newTaskId,
} from '@artifact-ax/contract';
import { BRIDGE_PROTOCOL_VERSION, BridgeClient, hasMinimalBundle, type ContextBundle } from '@artifact-ax/trigger';

/** artifactctl — the external capability gateway (docs/04-ax-contract.md). */

interface CommonOptions {
  url: string;
  workspace: string;
  artifact: string;
  as: string;
  actorType?: string;
  ownerId?: string;
}

function die(error: unknown, code = 1): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(code);
}

function printJSON(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printNDJSON(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parseCommon(values: Record<string, unknown>, requiredArtifact = true): CommonOptions {
  const artifact = values['artifact'];
  if (requiredArtifact && typeof artifact !== 'string') {
    throw new Error('missing required option --artifact <id>');
  }
  return {
    url: typeof values['url'] === 'string' ? values['url'] : process.env['AX_SERVICE_URL'] ?? 'http://127.0.0.1:8787',
    workspace: typeof values['workspace'] === 'string' ? values['workspace'] : 'ws_demo',
    artifact: typeof artifact === 'string' ? artifact : 'lesson-report',
    as: typeof values['as'] === 'string' ? values['as'] : process.env['AX_ACTOR'] ?? 'agent_440',
    actorType: typeof values['actor-type'] === 'string' ? values['actor-type'] : 'agent',
    ...(typeof values['owner-id'] === 'string' ? { ownerId: values['owner-id'] } : {}),
  };
}

function actorOf(options: CommonOptions): ActorInput {
  return {
    id: options.as,
    type: (options.actorType ?? 'agent') as ActorInput['type'],
    ...(options.ownerId ? { owner_id: options.ownerId } : {}),
  };
}
function gateway(options: CommonOptions): HttpAxGateway {
  return new HttpAxGateway(options.url!, actorOf(options));
}

async function cmdDescribe(args: string[], values: Record<string, unknown>): Promise<void> {
  const options = parseCommon(values);
  const manifest = await gateway(options).describe({
    workspace_id: options.workspace,
    artifact_id: options.artifact,
    actor: actorOf(options),
  });
  printJSON(manifest);
}

async function cmdInspect(args: string[], values: Record<string, unknown>): Promise<void> {
  const options = parseCommon(values);
  const region = typeof values['region'] === 'string' ? values['region'] : undefined;
  const cursor = values['cursor'] !== undefined ? Number(values['cursor']) : undefined;
  const projection = await gateway(options).inspect({
    workspace_id: options.workspace,
    artifact_id: options.artifact,
    actor: actorOf(options),
    ...(region ? { region } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    max_events: values['max-events'] !== undefined ? Number(values['max-events']) : 50,
  });
  printJSON(projection);
}

async function cmdApply(args: string[], values: Record<string, unknown>): Promise<void> {
  const options = parseCommon(values);
  const name = args[0];
  if (!name) throw new Error('usage: artifactctl apply <capability> --input <json>');
  const rawInput = readInputValue(values);
  let inputJson: Record<string, unknown>;
  try {
    inputJson = JSON.parse(rawInput) as Record<string, unknown>;
  } catch {
    throw new Error('--input must be valid JSON');
  }
  const baseRevision = Number(values['revision'] ?? -1);
  const command: CommandInput = {
    command_id: typeof values['command-id'] === 'string' ? values['command-id'] : newCommandId(),
    workspace_id: options.workspace,
    artifact_id: options.artifact,
    version: values['version'] !== undefined ? Number(values['version']) : 1,
    base_revision: baseRevision,
    actor: actorOf(options),
    name,
    args: inputJson,
    ...(typeof values['idempotency-key'] === 'string' ? { idempotency_key: values['idempotency-key'] } : {}),
  };
  const result = await gateway(options).apply(command);
  printJSON(result);
}

async function cmdWatch(args: string[], values: Record<string, unknown>): Promise<void> {
  const options = parseCommon(values);
  const cursor = values['cursor'] !== undefined ? Number(values['cursor']) : undefined;
  const timeoutMs = values['timeout'] !== undefined ? Number(values['timeout']) * 1000 : 30_000;
  const includeType = values['include-type'] !== undefined ? String(values['include-type']) : undefined;
  const gatewayClient = gateway(options);
  let count = 0;
  for await (const envelope of gatewayClient.watch({
    workspace_id: options.workspace,
    artifact_id: options.artifact,
    actor: actorOf(options),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(timeoutMs > 0 ? { timeout_ms: timeoutMs } : {}),
    ...(includeType ? { include_types: [includeType] } : {}),
  })) {
    if (envelope.kind === 'event') {
      count += 1;
      printNDJSON(envelope.event);
    } else if (envelope.kind === 'heartbeat') {
      if (values['verbose']) printNDJSON(envelope);
    } else if (envelope.kind === 'done') {
      break;
    }
  }
  if (values['verbose'] === true) {
    printNDJSON({ kind: 'done', reason: 'timeout', events_seen: count });
  }
}

async function cmdPublish(args: string[], values: Record<string, unknown>): Promise<void> {
  const options = parseCommon(values);
  const taskId = newTaskId();
  const g = gateway(options);
  const existingDraft = typeof values['draft'] === 'string' ? values['draft'] : undefined;

  // Minimal build loop: create a draft (builder), validate it structurally,
  // then publish. Publishing requires an actor with the publish scope and a
  // resolved publish approval -- run the second step as a reviewer with
  // `--draft <id> --approval <id>` (docs: publish <draft> --approval <token>).
  let draftId: string;
  let validated: Draft;
  if (existingDraft !== undefined) {
    validated = await g.validateDraft({
      workspace_id: options.workspace,
      artifact_id: options.artifact,
      draft_id: existingDraft,
      actor: actorOf(options),
    });
    draftId = existingDraft;
  } else {
    const changeSetRaw = readInputValue(values, true);
    let changeSet: Record<string, unknown> = {};
    if (changeSetRaw !== '' && changeSetRaw !== '{}') {
      try {
        changeSet = JSON.parse(changeSetRaw) as Record<string, unknown>;
      } catch {
        throw new Error('--input (draft change set) must be valid JSON');
      }
    }
    const created = await g.createDraft({
      workspace_id: options.workspace,
      artifact_id: options.artifact,
      builder: actorOf(options),
      change_set: changeSet as DraftChangeSet,
    });
    validated = await g.validateDraft({
      workspace_id: options.workspace,
      artifact_id: options.artifact,
      draft_id: created.draft_id,
      actor: actorOf(options),
    });
    draftId = created.draft_id;
  }
  const result = await g.publish({
    workspace_id: options.workspace,
    artifact_id: options.artifact,
    draft_id: draftId,
    actor: actorOf(options),
    ...(typeof values['approval'] === 'string' ? { approval_id: values['approval'] } : {}),
  });
  printJSON({ task_id: taskId, draft: validated, publish: result });
}

function readInputValue(values: Record<string, unknown>, optional = false): string {
  if (typeof values['input'] === 'string') return values['input'];
  if (typeof values['input-file'] === 'string') {
    return readFileSyncQuiet(values['input-file']);
  }
  if (optional) return '';
  throw new Error('missing --input <json> (or --input-file <path>)');
}

// ---------------- context / inbox (external Agent Bridge) -------------------

function bridgeClient(values: Record<string, unknown>): BridgeClient {
  const url = typeof values['bridge-url'] === 'string' ? values['bridge-url'] : process.env['AX_BRIDGE_URL'] ?? 'http://127.0.0.1:8788';
  const token = typeof values['token'] === 'string' ? values['token'] : process.env['AX_BRIDGE_TOKEN'];
  const sessionToken = typeof values['session'] === 'string' ? values['session'] : process.env['AX_BRIDGE_SESSION'];
  return new BridgeClient({ baseURL: url, ...(token ? { token } : {}), ...(sessionToken ? { sessionToken } : {}) });
}

function readBundle(values: Record<string, unknown>): ContextBundle {
  const raw =
    typeof values['bundle'] === 'string'
      ? values['bundle']
      : typeof values['bundle-file'] === 'string'
        ? readFileSyncQuiet(values['bundle-file'])
        : (() => {
            throw new Error('missing --bundle <json> (or --bundle-file <path>)');
          })();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('--bundle (or --bundle-file) must be valid JSON ContextBundle');
  }
  if (!hasMinimalBundle(parsed)) {
    throw new Error('--bundle must be a valid ContextBundle (bundle_id, artifact_id, revision, selections, intent)');
  }
  return parsed;
}

async function cmdContext(args: string[], values: Record<string, unknown>): Promise<void> {
  const [sub, ..._rest] = args;
  const client = bridgeClient(values);
  switch (sub) {
    case 'send': {
      const bundle = readBundle(values);
      const receipt = await client.submit({
        bundle,
        ...(typeof values['mode'] === 'string' ? { mode: values['mode'] as 'send' | 'queue' | 'confirm' } : {}),
        ...(typeof values['idempotency-key'] === 'string' ? { idempotency_key: values['idempotency-key'] } : {}),
        ...(values['ttl-ms'] !== undefined ? { ttl_ms: Number(values['ttl-ms']) } : {}),
      });
      printJSON(receipt);
      return;
    }
    case 'status': {
      const id = typeof values['bundle-id'] === 'string' ? values['bundle-id'] : undefined;
      if (id !== undefined) {
        const receipt = await client.get(id);
        if (!receipt) die(`no bundle '${id}' on bridge`);
        printJSON(receipt);
        return;
      }
      const state = typeof values['state'] === 'string' ? (values['state'] as never) : undefined;
      const receipts = await client.list(state);
      printJSON({ count: receipts.length, receipts });
      return;
    }
    case 'fetch': {
      const id = requireBundleId(values, sub);
      const bundle = await client.getBundle(id);
      if (!bundle) die(`no bundle '${id}' on bridge`);
      printJSON({ protocol_version: BRIDGE_PROTOCOL_VERSION, bundle });
      return;
    }
    case 'watch': {
      const timeoutMs = values['timeout'] !== undefined ? Number(values['timeout']) * 1000 : 30_000;
      const state = typeof values['state'] === 'string' ? (values['state'] as never) : undefined;
      let count = 0;
      const stream = client.watch(state, { timeoutMs });
      for await (const envelope of stream) {
        if (envelope.kind === 'receipt') {
          count += 1;
          printNDJSON({ type: 'receipt', state: envelope.receipt.state, bundle_id: envelope.receipt.bundle_id, receipt_id: envelope.receipt.receipt_id });
        } else {
          break;
        }
      }
      if (values['verbose'] === true) {
        printNDJSON({ type: 'done', reason: 'close', receipts_seen: count });
      }
      return;
    }
    case 'ag-ui': {
      const timeoutMs = values['timeout'] !== undefined ? Number(values['timeout']) * 1000 : 30_000;
      const state = typeof values['state'] === 'string' ? (values['state'] as never) : undefined;
      const bundleId = typeof values['bundle-id'] === 'string' ? values['bundle-id'] : undefined;
      const includeContext = values['include-context'] === true;
      let count = 0;
      const stream = client.watchAgUi({ state, bundleId, includeContext, timeoutMs });
      for await (const envelope of stream) {
        if (envelope.kind === 'event') {
          count += 1;
          printNDJSON(envelope.event);
        } else {
          break;
        }
      }
      if (values['verbose'] === true) {
        printNDJSON({ type: 'done', reason: 'close', events_seen: count });
      }
      return;
    }
    case 'ack': {
      const id = requireBundleId(values, sub);
      const receipt = await client.ack(id);
      printJSON(receipt);
      return;
    }
    case 'resume': {
      const id = requireBundleId(values, sub);
      const receipt = await client.resume(id);
      printJSON(receipt);
      return;
    }
    case 'complete': {
      const id = requireBundleId(values, sub);
      const receipt = await client.complete(id);
      printJSON(receipt);
      return;
    }
    case 'reject': {
      const id = requireBundleId(values, sub);
      const reason = typeof values['reason'] === 'string' && values['reason'].trim() !== '' ? values['reason'] : 'policy';
      const receipt = await client.reject(id, reason);
      printJSON(receipt);
      return;
    }
    default:
      throw new Error('usage: artifactctl context <send|status|fetch|watch|ag-ui|ack|resume|complete|reject>');
  }
}

function requireBundleId(values: Record<string, unknown>, sub: string): string {
  const id = typeof values['bundle-id'] === 'string' ? values['bundle-id'] : undefined;
  if (!id) throw new Error(`usage: artifactctl context ${sub} --bundle-id <id>`);
  return id;
}


function readFileSyncQuiet(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`cannot read --input-file ${path}: ${error instanceof Error ? error.message : error}`);
  }
}

const COMMANDS: Record<string, { minArgs: number; run: (args: string[], values: Record<string, unknown>) => Promise<void> }> = {
  describe: { minArgs: 0, run: cmdDescribe },
  inspect: { minArgs: 0, run: cmdInspect },
  apply: { minArgs: 1, run: cmdApply },
  watch: { minArgs: 0, run: cmdWatch },
  publish: { minArgs: 0, run: cmdPublish },
  context: { minArgs: 1, run: cmdContext },
};

const USAGE = `artifactctl — external AX capability gateway

Usage:
  artifactctl describe  --artifact <id> [--workspace <ws>] [--as <actor>] [--url <base>]
  artifactctl inspect   --artifact <id> [--region <id>] [--cursor <n>] [--as <actor>] ...
  artifactctl apply     <capability> --artifact <id> --input <json> [--revision <n>] [--version <n>] [--idempotency-key <k>]
  artifactctl watch     --artifact <id> [--cursor <n>] [--timeout <sec>] [--include-type <type>]
  artifactctl publish   --artifact <id> [--draft <id>] --input <change-set-json> [--approval <id>]
  artifactctl context   <send|status|fetch|watch|ag-ui|ack|resume|complete|reject> (external Agent Bridge)

context / inbox (external Agent Bridge, artifact.ax.bridge.v1):
  artifactctl context send     --bundle <json> [--mode send|queue|confirm] [--ttl-ms <n>] [--idempotency-key <k>] [--bridge-url <u>] [--token <t>] [--session <s>]
  artifactctl context status   [--bundle-id <id>] [--state <s>] [--bridge-url <u>] [--token <t>] [--session <s>]
  artifactctl context fetch    --bundle-id <id> [--bridge-url <u>] [--token <t>] [--session <s>]
  artifactctl context watch    [--state <s>] [--timeout <sec>] [--bridge-url <u>] [--token <t>] [--session <s>]
  artifactctl context ag-ui    [--state <s>] [--bundle-id <id>] [--include-context] [--timeout <sec>] [--bridge-url <u>] [--token <t>] [--session <s>]
  artifactctl context ack      --bundle-id <id> [--bridge-url <u>] [--token <t>] [--session <s>]
  artifactctl context resume   --bundle-id <id> [--bridge-url <u>] [--token <t>] [--session <s>]
  artifactctl context complete --bundle-id <id> [--bridge-url <u>] [--token <t>] [--session <s>]
  artifactctl context reject   --bundle-id <id> [--reason <text>] [--bridge-url <u>] [--token <t>] [--session <s>]

  --bridge-url <base>   bridge base URL (default $AX_BRIDGE_URL or http://127.0.0.1:8788)
  --token <t>           pairing token (default $AX_BRIDGE_TOKEN; loopback + token, not production auth)
  --session <s>         opaque Artifact session (default $AX_BRIDGE_SESSION; keep it out of shell history)
  --bundle <json>       full ContextBundle (or --bundle-file <path>)

Global:
  --url <base>          AX service base URL (default $AX_SERVICE_URL or http://127.0.0.1:8787)
  --workspace <ws>      default ws_demo
  --as <actor-id>       default $AX_ACTOR or agent_440
  --actor-type <type>   human | agent | service | system (default agent)
  --owner-id <uid>      delegated grant owner

Output is JSON; watch emits one JSON object per line (NDJSON).
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h' || command === undefined) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write('artifactctl 0.1.0\n');
    return 0;
  }
  const spec = COMMANDS[command];
  if (!spec) {
    process.stderr.write(`unknown command: ${command}\n`);
    process.stderr.write(USAGE);
    return 2;
  }
  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        artifact: { type: 'string' },
        workspace: { type: 'string' },
        url: { type: 'string' },
        as: { type: 'string' },
        'actor-type': { type: 'string' },
        'owner-id': { type: 'string' },
        region: { type: 'string' },
        cursor: { type: 'string' },
        'max-events': { type: 'string' },
        'command-id': { type: 'string' },
        'idempotency-key': { type: 'string' },
        input: { type: 'string' },
        'input-file': { type: 'string' },
        revision: { type: 'string' },
        version: { type: 'string' },
        timeout: { type: 'string' },
        'include-type': { type: 'string' },
        draft: { type: 'string' },
        approval: { type: 'string' },
        'bridge-url': { type: 'string' },
        token: { type: 'string' },
        session: { type: 'string' },
        bundle: { type: 'string' },
        'bundle-file': { type: 'string' },
        mode: { type: 'string' },
        'ttl-ms': { type: 'string' },
        'bundle-id': { type: 'string' },
        state: { type: 'string' },
        reason: { type: 'string' },
        'include-context': { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (parsed.positionals.length > 0 && parsed.values['_positionals'] === undefined) {
    // Sub-args like `apply <capability>` arrive as positionals.
    parsed.values['_positionals'] = parsed.positionals;
  }
  try {
    await spec.run(parsed.positionals, parsed.values);
    return 0;
  } catch (error) {
    die(error);
    return 1;
  }
}

// Direct execution (bin entry). Resolves the symlinked bin to the real file.
const isMain = (() => {
  try {
    return process.argv[1] != null && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  void main().then((code) => process.exit(code));
}
