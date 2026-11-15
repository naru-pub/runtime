# Naru runtime

The code every [Naru](https://naru.pub) site runs on: the Data SDK a site's
pages import, the runtime that holds each site's SQLite database and runs its
`_naru/` code (migrations, queries, mutations, routes, live queries), and
naru-dev, which runs both on your own machine. Naru serves sites from this
same code; the rest of Naru (accounts, hosting, billing) is not here.

| Folder | What it is |
| --- | --- |
| [`sdk/`](sdk/) | The Data SDK: its source (`source/<version>/naru.ts`), the committed files Naru serves at `https://sdk.naru.pub/sdk/<version>/` (`files/`), and the [`@naru-pub/sdk`](https://www.npmjs.com/package/@naru-pub/sdk) package |
| [`src/`](src/) | The runtime, a Cloudflare Workers-style module run under [workerd](https://github.com/cloudflare/workerd): `site.ts` (a site's object and its database), `website.ts` (the data API and live connections), `functions.ts` and `quickjs.ts` (site code, metered in QuickJS), `operations.ts` (the operations on a site), and `dev.ts`, naru-dev's entry |
| [`dev/`](dev/) | [`@naru-pub/dev`](https://www.npmjs.com/package/@naru-pub/dev): run and test a Naru site locally |
| [`quickjs/`](quickjs/) | The metered QuickJS WebAssembly site code runs in, and the tool that makes it |
| [`docs/`](docs/) | The [Data SDK v1 reference](docs/sdk-v1-api.md); [`FUNCTION-IMPORTS.md`](FUNCTION-IMPORTS.md) on how site code is published and run |

## Development

Node.js 24 and pnpm 11:

```bash
pnpm install
pnpm test          # the runtime's suites (vitest)
pnpm typecheck
pnpm test:sdk      # the SDK's specs (node:test)
pnpm sdk:check     # sdk/files/ is what sdk/source/ emits
```

After editing an SDK version still being built (`sdk/scripts/emit.mjs`'s
`VERSIONS`), run `pnpm sdk:build` and commit what it writes. Frozen versions
never change.

To run a site against this checkout:

```bash
cd dev
pnpm install
pnpm start ../path/to/site --site demo
```

## License

[MIT](LICENSE).
