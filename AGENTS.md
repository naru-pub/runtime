# Repository Notes

This repository is public. Naru's private repository (naru-pub/naru) pins it
as a git submodule at `runtime/` and builds on it: its control plane imports
`src/site-data/`, `src/site-functions/` and `src/uuid.ts` as `@runtime/`, and
its Workers import the runtime's modules directly. Nothing here imports from
there; keep it that way, and keep private details (hosts, accounts, internal
paths) out of code, comments and docs.

A change to `src/site-data/`, `src/site-functions/` or the operations'
shapes (`operations.ts`, `site.ts`) is a change to what the private control
plane calls: land it here first, then bump the submodule there.

## SDK

`sdk/source/<version>/naru.ts` (and from 1.2.0 `handoff.ts`, the builder
handoff) is the source; `sdk/files/<version>/` is what it emits and what Naru
serves. Run `pnpm sdk:build` after editing a version
still in `sdk/scripts/emit.mjs`'s `VERSIONS`, and commit both. A frozen
version's files are checked byte for byte (`sdk/spec/frozen-sdk.test.mjs`).
