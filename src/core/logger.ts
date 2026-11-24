import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { workflowDir } from "./paths.js";

/** JSONL run log. File is deliberately ignored by Git; values can be sensitive. */
export class RunLogger {
  readonly path: string;
  private pending: Promise<void> = Promise.resolve();

  constructor() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.path = join(workflowDir(), `${stamp}-${randomUUID().slice(0, 8)}.log`);
  }

  write(event: string, details: Record<string, unknown> = {}): Promise<void> {
    this.pending = this.pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, JSON.stringify({ at: new Date().toISOString(), event, ...details }) + "\n");
    });
    return this.pending;
  }

  flush(): Promise<void> { return this.pending; }
}
