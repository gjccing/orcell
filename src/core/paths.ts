import { resolve } from "node:path";

/** Logs, environments, and Node runtimes live in the directory where orcell was started. */
export function workflowDir(): string {
  return resolve(process.cwd(), ".workflow");
}
