# Project Instructions

This repository is a docs-first design project for an independent, AX-friendly Artifact application.

## Scope

- Keep this project independent from `cats-company`.
- Treat `cats-company` as an integration target and identity provider candidate, not as a source dependency.
- Do not add a generic Artifact runtime unless a later decision explicitly requires one.
- Keep the Artifact application usable without an Agent.

## Tooling preferences

- Use `pnpm` for Node.js work.
- Use `mise` for language and tool versions.
- Use PDM or UV for Python work.
- Use Homebrew for system packages.

## Documentation rules

- Record assumptions separately from facts observed in `cats-company`.
- Include a source path or link for repository-specific claims.
- Prefer stable contracts, semantic commands, and versioned changes over DOM automation.
