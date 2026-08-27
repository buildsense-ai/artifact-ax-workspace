/**
 * @artifact-ax/catsco-adapter — browser-safe surface (no node builtins).
 * Import only this entry from the SPA or CLI; use the ./server subpath for
 * the Artifact node server.
 */
export { HttpAxGateway } from './http-client.js';
export { renderIndex, renderManagementList, renderOperation, artifactPublicURL, artifactSidecarURL } from './render.js';
export type { NodeURLLayout, ExportOptions } from './render.js';