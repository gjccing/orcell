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

Both languages run with the installed Node.js version and use the same process worker.
No Docker and no other language runtimes in v0.0.1.

`code.version` is an optional **Node.js runtime version for both JavaScript and TypeScript cells** (for example, `22.14.0`). The XSD only checks that the value is nonempty; the loader checks the format and whether that version is installed. The TypeScript compiler version is selected internally by the TypeScript loader and cannot be specified by `code.version`. The current loader does not automatically install or switch Node.js versions.

## Runtime files

A workflow run stores environment and logs **next to the workflow XML**, under `.workflow/`:

```text
examples/.workflow/
├── 2026-...-....log
└── environments/
    └── <environment-sha256>/
        ├── package.json
        ├── package-lock.json        # when npm dependencies exist
        ├── node_modules/           # when npm dependencies exist
        ├── .ready.json
        └── cells/<code-sha256>.mjs
```

Environment identity is based on the Node runtime, normalized dependencies, platform and architecture. JavaScript and TypeScript cells can share one environment; TypeScript transpilation uses its own code cache key. **Cells with compatible configurations reuse the same environment**. Each cell execution itself still uses a fresh OS process.

By default, Code Cells run with the invoking user's permissions. Only run trusted XML workflows and package dependencies.

## Development

```bash
npm run typecheck
npm test
npm run build
```

Detailed architecture, IPC and limitations: [docs/architecture.md](docs/architecture.md).

### Important limitations

v0.0.1 implements the basic JS/TS and LLM runner paths, but requires local end-to-end testing after installing dependencies. `version` checks the locally installed Node.js runtime rather than downloading other versions; TypeScript compiler selection stays internal to its loader. Python, background scheduling, parallelism, process pooling, execution timeout, sandboxing and GUI are not implemented.

The test environment in which this archive was created did **not** have npm registry access. Therefore build/integration tests could not be completed there. XML examples and XSD are validated separately.

## GitHub

The repository has not been created remotely. After extracting the ZIP, create it from this folder using GitHub CLI:

```bash
git init -b main
git add .
git commit -m "chore: initialize orcell v0.0.1"
gh repo create gjccing/orcell --private --source=. --remote=origin --push
```
