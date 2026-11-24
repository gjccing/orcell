# Orcell development guidance

## Intent

Orcell is a cell-based XML workflow engine, not a visual editor. Each workflow is a sequence of isolated code and LLM cells. Version 0.0.3 exposes **only** two CLI commands: `orcell validate <file>` and `orcell run <file>`.

## Non-negotiable behavior

- `run` validates the input against `schemas/workflow.xsd` before execution.
- A run owns a distinct Workflow Context. Code cells interact through `wf.getState`, `wf.setState`, `wf.getReturn`, `wf.getReturns`, `wf.env`.
- Cells execute in document order. Code cells are **fresh processes**; environment dependencies may be **reused**.
- `stdout` and `stderr` remain user-facing streams. Function return and pending state changes travel separately on fd 3.
- Failed code execution must not commit its pending Context changes. Do not assume file/DB side effects can be rolled back.
- `<description>`, `<comment-start>`, and `<comment-end>` never change execution semantics; `static` is metadata.
- Keep `schemas/workflow.xsd` authoritative; do not silently add XML tags or commands.

## Architecture boundaries

- `src/xml`: parse and validate input.
- `src/core`: run context, orchestration, expression resolver, logging.
- `src/loaders/js.ts`: JavaScript loader; `src/loaders/ts.ts`: TypeScript loader.
- `src/loaders/environment.ts`: shared lazy Node.js environment and dependency cache.
- Do not introduce Docker or other language runtimes into v0.0.3.
- `src/runners`: execute code in child processes, call a subscription CLI or the AI Gateway.
- `examples`: small runnable workflows.

## Acceptance criteria

After `npm install && npm run build`:

1. `orcell validate examples/hello.xml` exits 0.
2. Invalid XML or invalid XSD attribute exits nonzero without executing code.
3. `orcell run examples/hello.xml` prints a count of 2.
4. `orcell run examples/dependencies.xml` installs dependencies once per compatible environment (npm network required first time).
5. A run creates `.workflow/<timestamp>-<id>.log` in the current working directory and reuses `.workflow/environments/<hash>/` on subsequent executions.
6. `npm test` passes.

## Known gaps

- Environment reuse is an exact match of Node.js version, platform, architecture, and dependency specs. Compatible ranges are later work.
- No workflow loop. Each cell runs once, so one `<llm>` cell is one model call.
- Only JavaScript/TypeScript code runners exist.
- No concurrent cache preparation lock, code process timeout, sandbox, imported local TS compilation, parallelism, or persistence across runs.

When changing this project, first preserve a working `validate` + `run` path, and keep the CLI scope minimal.
