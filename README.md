# dropin SDKs

Client SDKs for [dropin](https://docs.getnodex.cloud) — a GetStream-shaped activity feed as
a service. Feeds follow feeds, activities fan out along follow edges, users react.

| Package | What it is |
|---|---|
| [`@dropinnodex/client`](packages/client) | Isomorphic, zero-dependency. Browser or Node. |
| [`@dropinnodex/server`](packages/server) | Node only. Mints user tokens offline; never ship it to a browser. |
| [`@dropinnodex/react`](packages/react) | Hooks with optimistic updates and rollback. |

```bash
npm i @dropinnodex/client
```

Full documentation: **https://docs.getnodex.cloud**

## About this repository

This repository is **generated**. The SDKs are developed in a private monorepo alongside the
service they talk to, and every release is copied here as a single commit. Editing files
here directly would be overwritten by the next release.

That means **pull requests cannot be merged.** Please [open an
issue](https://github.com/dropinnodex/dropin-sdks/issues) instead — bug reports,
API feedback, and patches pasted into an issue are all genuinely welcome, and land upstream
with attribution.

Published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements):
every release on npm links back to the commit and workflow run here that built it.

## Licence

MIT
