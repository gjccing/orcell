import { readFileSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

interface WorkerInput {
  state: Record<string, unknown>;
  returns: Record<string, unknown[]>;
}

async function main(): Promise<void> {
  const filename = process.argv[2];
  if (!filename) throw new Error("Missing cell module path");
  const input = JSON.parse(readFileSync(0, "utf8")) as WorkerInput;
  const state: Record<string, unknown> = { ...input.state };
  const changes: Record<string, unknown> = {};
  const operations: { method: string; key: string; value?: unknown }[] = [];
  const wf = {
    getState: (key: string) => {
      const value = state[key];
      operations.push({ method: "getState", key, value });
      return value;
    },
    setState: (key: string, value: unknown) => {
      state[key] = value;
      changes[key] = value;
      operations.push({ method: "setState", key, value });
    },
    getReturn: (name: string) => input.returns[name]?.at(-1),
    getReturns: (name: string) => [...(input.returns[name] ?? [])],
    env: (key: string) => process.env[key],
  };
  const mod: unknown = await import(pathToFileURL(filename).href);
  const entry = (mod as { default?: unknown }).default;
  if (typeof entry !== "function") throw new TypeError("Code cell must export default function(wf)");
  const value: unknown = await entry(wf);
  // fd 3 carries the control payload, separate from user stdout and stderr.
  writeSync(3, JSON.stringify({ value, changes, operations }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
