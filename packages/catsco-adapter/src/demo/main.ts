import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { ArtifactService } from '@artifact-ax/domain';
import { LESSON_REPORT_MEMBERS, LESSON_REPORT_SPEC } from '@artifact-ax/lesson-report';
import { ArtifactNodeServer } from '../node-server.js';

/**
 * Demo Artifact node: an in-memory domain service seeded with the teaching
 * report, exposed through the CatsCo-compatible management surface and the
 * AX HTTP gateway. Serves the built demo SPA at the artifact public URL.
 *
 * Run: pnpm demo:serve  (after pnpm build)
 * Env:   AX_PORT (default 8787), AX_MGMT_TOKEN (default demo token)
 */
const here = dirname(fileURLToPath(import.meta.url));
// Fall back to the workspace-root layout so both tsx (src) and node (dist)
// runs find the built SPA: <workspace>/apps/demo-spa/dist.
const spaDist = process.cwd()
  ? join(process.cwd(), 'apps/demo-spa/dist')
  : resolve(here, '../../../../apps/demo-spa/dist');

const port = Number(process.env['AX_PORT'] ?? 8787);
const host = process.env['AX_HOST'] ?? '127.0.0.1';
const publicBaseURL = process.env['AX_PUBLIC_BASE_URL'] ?? `http://${host}:${port}`;
const managementToken = process.env['AX_MGMT_TOKEN'] ?? 'artifact-ax-demo-management-token-0123456789abcdef';

const service = new ArtifactService({
  specs: [LESSON_REPORT_SPEC],
  workspaces: [{ id: 'ws_demo', members: [...LESSON_REPORT_MEMBERS] }],
});

const server = new ArtifactNodeServer({
  service,
  publicBaseURL,
  managementToken,
  staticDir: spaDist,
});

await server.listen(port, host);
const address = server.address();
console.log('');
console.log('artifact-ax demo node (mock transport) ready');
console.log(`  AX API        : http://${host}:${address?.port}/ax/v1/{describe,inspect,apply,watch,publish}`);
console.log(`  CatsCo index  : http://${host}:${address?.port}/artifacts-index.json`);
console.log(`  CatsCo mgmt   : http://${host}:${address?.port}/internal/artifacts?status=active`);
console.log(`  Agent scope   : http://${host}:${address?.port}/internal/agents/440/artifacts?status=active`);
console.log(`  Artifact page : ${publicBaseURL}/by-agent/440/lesson-report/latest/`);
console.log(`  Sidecar       : ${publicBaseURL}/by-agent/440/lesson-report/latest/artifact.ax.json`);
console.log(`  Management    : Authorization: Bearer ${managementToken.slice(0, 8)}...(demo token)`);
console.log('');
console.log('  Try:');
console.log(`    pnpm --filter artifactctl artifactctl describe ws_demo lesson-report --as agent_440 --url http://${host}:${address?.port}`);
console.log('');

// Keep the process alive; close cleanly on SIGINT.
const shutdown = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);