# Orcell v0.0.1 architecture

## Scope

Exactly two CLI commands: `orcell validate <path>` and `orcell run <path>`.

## Execution

```
CLI
  └─ XML + XSD validation
     └─ XML Parser
        └─ Orchestrator (sequential)
           ├─ Workflow Context (per run)
           ├─ Environment Cache (lazy) + js.ts / ts.ts language loaders
           │  └─ Environment cache <cwd>/.workflow/environments/<sha256>/
           │     ├─ package.json, optional package-lock.json, node_modules/
           │     └─ cells/<code-sha256>.mjs
           ├─ Code Runner (fresh child process per invocation)
           │  ├─ stdin: context snapshot
           │  ├─ stdout/stderr: user output and errors
           │  └─ fd 3: return + state changes + context access events
           ├─ LLM Runner (Vercel AI Gateway HTTP API)
           └─ <cwd>/.workflow/<timestamp>-<id>.log (JSON Lines)
```

## Isolation and caching

- Environment cache key is SHA-256 of canonicalized Node runtime version, operating system, architecture, and normalized dependency specifications. JS and TS may share a Node environment; code compilation is cached separately by source, language, and compiler version.
- The first cell to use an environment creates it lazily. Compatible cells reuse it without another `npm install`.
- Dependencies resolve through the environment-local `node_modules`; compiled cell modules live **inside** that environment so Node ESM resolution works.
- The environment is cached, but the process is **not**. Every cell invocation launches a new Node child process; module singletons are not reused.
- `package-lock.json` records the versions actually installed. Cache creation isn't yet concurrency-safe against simultaneous separate CLI processes preparing the same environment.
- `version` specifies the Node.js runtime for **both** JavaScript and TypeScript cells. The loader requires `major.minor.patch`. The Node running Orcell is used when the attribute is omitted or names that same release; any other release is downloaded from nodejs.org into `.workflow/runtimes/node/<version>/` and used for that cell and its `npm install`. The TypeScript compiler is fixed by the TypeScript loader.

## Workflow Context

`wf.getState(key)`, `wf.setState(key, value)`, `wf.getReturn(cellName)`, `wf.getReturns(cellName)`, `wf.env(name)`.

- Each run starts with a fresh context.
- Child processes receive a snapshot on stdin. Their writes are accumulated and committed only on successful return; a later cell can see them.
- `stdout` and `stderr` stream to the terminal. A separate fd 3 carries the protocol JSON.
- A code cell can access the entire invoking user's OS environment and files. Only run trusted workflows.

## MVP limitations

- Only `lang="javascript"` and `lang="typescript"` are accepted (no `js` or `ts` aliases). Python and multi-runtime support are not present.
- Per-cell dependency install uses npm and needs access to the npm registry (unless packages are cached). Install scripts run with the invoking user's permissions.
- No TypeScript full type-check of cell source, no automatic transpilation of imported TS files.
- No cross-run persistent State, scheduling, parallelism, retry, run cancellation, sandbox, or execution timeout for Code Cells.
- No transactional rollback of file/DB/network side effects.
- `<description>` and comment markers are non-executable; `static` is planner metadata only.
- LLM calls require a configured API key and were not exercised in the offline test environment.
- Logs contain Context values and output. Do not commit `.workflow/`.
- Local relative JS/TS module imports from the original XML directory are not remapped in this MVP; package imports from the environment's `node_modules` work through standard Node resolution.
