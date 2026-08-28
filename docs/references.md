# References

## AG-UI

- [Introduction](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/introduction.mdx)
- [Architecture](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/concepts/architecture.mdx)
- [Events](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/concepts/events.mdx)
- [State management](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/concepts/state.mdx)
- [Tools](https://docs.ag-ui.com/concepts/tools)
- [Generative UI specifications](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/concepts/generative-ui-specs.mdx)

AG-UI supplies an Agent-to-UI event vocabulary and transport-facing concepts. This project uses it as an optional adapter, not as the Artifact domain model.

## Projects studied

- [Sayhi-bzb/Agent-HTML](https://github.com/Sayhi-bzb/Agent-HTML)
- [pskoett/pmx-canvas](https://github.com/pskoett/pmx-canvas)

Agent-HTML informs stable Artifact/Block/Region identity and structured interaction. PMX Canvas informs typed surfaces, bounded Agent context, capability ceilings, and server-side trust boundaries. The project does not import either project’s full host or canvas model.

## Cloud Artifact platform contract

- Local Skill package: `/Users/pi-dal/Downloads/cloud-html-artifact` (v1.4.0,
  read-only during this slice)
- Contract references: `references/context-contract.md`,
  `references/agent-task-loop.md`, `references/result-writeback.md`, and
  `references/publication-contract.md` under that package

The local path is an operator reference, not a repository dependency. The
standalone workspace ports only the bounded contracts it needs and leaves the
official publisher, injected bridge, and branding assets under CatsCo control.

## Local CatsCo sources

- [`cats-company/README.md`](../../cats-company/README.md)
- [`cats-company/server/auth.go`](../../cats-company/server/auth.go)
- [`cats-company/server/cloud_artifacts.go`](../../cats-company/server/cloud_artifacts.go)
- [`cats-company/server/artifact_nodes.go`](../../cats-company/server/artifact_nodes.go)
- [`cats-company/server/artifact_runtime_config.go`](../../cats-company/server/artifact_runtime_config.go)
- [`cats-company/server/datamodel.go`](../../cats-company/server/datamodel.go)
- [`cats-company/server/wshandler.go`](../../cats-company/server/wshandler.go)
- [`cats-company/docs/API.md`](../../cats-company/docs/API.md)
- [`cats-company/docs/ACCOUNT_CENTER_AUTH.md`](../../cats-company/docs/ACCOUNT_CENTER_AUTH.md)
- [`cats-company/docs/SERVICE_TOKEN_GUIDE.md`](../../cats-company/docs/SERVICE_TOKEN_GUIDE.md)
- [`cats-company/docs/api/websocket.md`](../../cats-company/docs/api/websocket.md)

The local research notes remain in [`cats-company/docs/research`](../../cats-company/docs/research) and provide the earlier comparison of Agent-HTML, PMX Canvas, and AG-UI.
