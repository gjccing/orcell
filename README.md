# Orcell

XML-defined workflows made of independent **Code Cells** and **LLM Cells**. Early-development TypeScript CLI, v0.0.1.

## Requirements

- Node.js **22+** and npm
- API key for LLM Cell examples (optional)
- Internet access for `npm install`, including environment-local dependencies when declared

## Get started

```bash
npm install
npm run build
npm link

orcell validate examples/hello.xml
orcell run examples/hello.xml
```

Run without global CLI linking: `node dist/cli.js run examples/hello.xml`.

### Exactly two commands

| Command | Meaning |
| --- | --- |
| `orcell validate path/to/workflow.xml` | XML syntax + `schemas/workflow.xsd` validation; no execution |
| `orcell run path/to/workflow.xml` | Validate, then execute cells in document order |

CLI usage errors return exit code 2; validation/execution errors return 1; success returns 0.

## Examples

- [`examples/hello.xml`](examples/hello.xml): two TypeScript cells exchanging state and return values.
- [`examples/versions.xml`](examples/versions.xml): one JavaScript cell on Node.js 22.9.0 and one TypeScript cell on Node.js 22.23.5. The first run downloads 22.23.5.
- [`examples/dependencies.xml`](examples/dependencies.xml): two JavaScript cells with matching npm dependencies; a shared cached environment gets prepared lazily on first use.
- [`examples/llm.xml`](examples/llm.xml): Vercel AI Gateway LLM cell with templating and JSON Schema output validation.

To run the LLM example:

```bash
export AI_GATEWAY_API_KEY='your-key'
orcell run examples/llm.xml
```

## JavaScript / TypeScript loader layout

XML `lang` must be the full name: `lang="javascript"` or `lang="typescript"`. Abbreviations (`js`, `ts`) are not accepted.

- `src/loaders/js.ts` — JavaScript source loader (no compilation).
- `src/loaders/ts.ts` — TypeScript transpilation to ESM.
- `src/loaders/environment.ts` — shared lazy Node.js environment/cache and npm dependencies.

Both languages use the same process worker. No Docker and no other language runtimes in v0.0.1.

`code.version` is an optional **Node.js runtime version for both JavaScript and TypeScript cells** (for example, `22.14.0`). The XSD only checks that the value is nonempty; the loader requires `major.minor.patch`. Omit it to use the Node that is running Orcell. Set it to run that cell on that release; a different release is downloaded from nodejs.org into `.workflow/runtimes/node/<version>/` on first use. The TypeScript compiler version is selected internally by the TypeScript loader and cannot be specified by `code.version`.

## Runtime files

A workflow run stores environment and logs in the directory where `orcell` is executed, under `.workflow/`:

```text
.workflow/
├── 2026-...-....log
├── runtimes/node/<version>/   # official Node.js build when code.version differs
└── environments/
    └── <environment-sha256>/
        ├── package.json
        ├── package-lock.json        # when npm dependencies exist
        ├── node_modules/           # when npm dependencies exist
        ├── .ready.json
        └── cells/<code-sha256>.mjs
```

An environment is reused only when the Node.js version, platform, architecture, and normalized dependency specs match exactly. JavaScript and TypeScript cells can share that environment; TypeScript transpilation has its own code cache key. Each cell execution still uses a fresh OS process.

By default, Code Cells run with the invoking user's permissions. Only run trusted XML workflows and package dependencies.

## Development

```bash
npm run typecheck
npm test
npm run build
```

Detailed architecture and IPC: [docs/architecture.md](docs/architecture.md).

## Later

The current `validate` and `run` path stays as it is until a design is chosen.

1. Let an LLM cell call local Claude Code and Codex. Tests and local runs should not have to spend AI Gateway credits.
2. Add a workflow loop. Cells run once, in document order, so one `<llm>` cell is one call. A loop is needed to judge one item at a time instead of placing every item in a single prompt.
3. Share one environment among code cells whose Node.js `version` and `dependencies` are compatible ranges, not only exact matches.
