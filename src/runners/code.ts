import { spawn } from "node:child_process";
import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodeCell } from "../core/types.js";
import type { WorkflowContext } from "../core/context.js";
import type { RunLogger } from "../core/logger.js";
import { compileCell, EnvironmentLoader } from "../loaders/environment.js";

interface CodeResult {
  value?: unknown;
  changes?: Record<string, unknown>;
  operations?: { method: string; key: string; value?: unknown }[];
}

/** Execute one cell in an ephemeral process, reusing only its prepared environment. */
export async function runCodeCell(
  cell: CodeCell,
  wf: WorkflowContext,
  workflowPath: string,
  loader: EnvironmentLoader,
  logger: RunLogger,
): Promise<unknown> {
  const environment = await loader.prepare(cell);
  const modulePath = await compileCell(cell, environment);
  await logger.write("environment", { cell: cell.name, hash: environment.hash, path: environment.path });
  const worker = fileURLToPath(new URL("./code-worker.js", import.meta.url));

  const result = await new Promise<CodeResult>((resolvePromise, reject) => {
    const env = environment.execPath === process.execPath
      ? process.env
      : { ...process.env, PATH: `${dirname(environment.execPath)}${delimiter}${process.env.PATH ?? ""}` };
    const child = spawn(environment.execPath, [worker, modulePath], {
      cwd: environment.path,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env,
    });
    let control = "";
    let done = false;
    const finish = (error?: Error, value?: CodeResult): void => {
      if (done) return;
      done = true;
      if (error) reject(error); else resolvePromise(value ?? {});
    };
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      void logger.write("stdout", { cell: cell.name, text: chunk.toString("utf8") });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      void logger.write("stderr", { cell: cell.name, text: chunk.toString("utf8") });
    });
    child.stdio[3]?.on("data", (chunk: Buffer) => { control += chunk.toString("utf8"); });
    child.once("error", (error) => finish(error));
    child.once("close", (exitCode, signal) => {
      if (exitCode !== 0) return finish(new Error(`Cell '${cell.name}' failed (exit=${exitCode}, signal=${signal})`));
      try { finish(undefined, JSON.parse(control) as CodeResult); }
      catch { finish(new Error(`Cell '${cell.name}' did not return a valid control payload`)); }
    });
    child.stdin.on("error", (error) => finish(error));
    child.stdin.end(JSON.stringify(wf.snapshot()));
  });
  // No partial state updates when worker fails. This doesn't roll back external side effects.
  wf.commit(result.changes ?? {});
  for (const op of result.operations ?? []) await logger.write("context", { cell: cell.name, ...op });
  await logger.write("return", { cell: cell.name, value: result.value });
  return result.value;
}
