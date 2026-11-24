import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubscriptionCli } from "./llm-model.js";
import { tokenUsageFromClaude, tokenUsageFromCodexStdout, tokenUsageFromCursor, type TokenUsage } from "./token-usage.js";

export interface SubscriptionResult {
  text: string;
  usage?: TokenUsage;
}

const CLI_TIMEOUT_MS = 120_000;

const CLIS: Record<SubscriptionCli, { bin: string; label: string; status: string[]; login: string[]; loginCommand: string }> = {
  cursor: { bin: "agent", label: "Cursor Agent", status: ["status", "--format", "json"], login: ["login"], loginCommand: "agent login" },
  claude: { bin: "claude", label: "Claude Code", status: ["auth", "status"], login: ["auth", "login"], loginCommand: "claude auth login" },
  codex: { bin: "codex", label: "Codex", status: ["login", "status"], login: ["login"], loginCommand: "codex login" },
};

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[], options: { input?: string; inherit?: boolean; timeoutMs?: number } = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const child = spawn(command, args, { stdio: options.inherit ? "inherit" : ["pipe", "pipe", "pipe"] });
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error(`${command} timed out after ${options.timeoutMs}ms`)));
    }, options.timeoutMs);
    let stdout = "";
    let stderr = "";
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      if (error.code === "ENOENT") finish(() => reject(new Error(`Command not found: ${command}`)));
      else finish(() => reject(error));
    });
    if (!options.inherit && child.stdout && child.stderr && child.stdin) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.stdin.end(options.input ?? "");
    }
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      finish(() => resolve({ code: code ?? 1, stdout, stderr }));
    });
  });
}

async function isSignedIn(cli: SubscriptionCli): Promise<boolean> {
  const spec = CLIS[cli];
  const result = await runCommand(spec.bin, spec.status);
  if (cli === "cursor") {
    try {
      const body = JSON.parse(result.stdout) as { isAuthenticated?: boolean };
      if (typeof body.isAuthenticated === "boolean") return body.isAuthenticated;
    } catch { /* Status text is enough when it is not JSON. */ }
  }
  return result.code === 0;
}

async function ensureSignedIn(cli: SubscriptionCli): Promise<void> {
  const spec = CLIS[cli];
  let signedIn: boolean;
  try {
    signedIn = await isSignedIn(cli);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Command not found:")) {
      throw new Error(`${spec.label} is not installed. ${spec.loginCommand.split(" ")[0]} was not found on PATH.`);
    }
    throw error;
  }
  if (signedIn) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${spec.label} is not signed in. Run \`${spec.loginCommand}\` in a terminal, then run this workflow again. A non-interactive run cannot guide login.`);
  }
  process.stderr.write(`${spec.label} is not signed in. Complete login in this terminal; the run continues after it succeeds.\n`);
  const login = await runCommand(spec.bin, spec.login, { inherit: true });
  if (login.code !== 0 || !(await isSignedIn(cli))) {
    throw new Error(`${spec.label} login did not finish. Run \`${spec.loginCommand}\` and try again.`);
  }
}

function promptWithSchema(prompt: string, outputSchema: unknown): string {
  if (outputSchema === undefined) return prompt;
  return `${prompt}\n\nRespond with JSON only, matching this schema:\n${JSON.stringify(outputSchema)}`;
}

async function runCursor(model: string | undefined, prompt: string): Promise<SubscriptionResult> {
  const args = ["--print", "--mode", "ask", "--trust", "--output-format", "json", "--workspace", process.cwd()];
  if (model) args.push("--model", model);
  args.push(prompt);
  const result = await runCommand("agent", args, { timeoutMs: CLI_TIMEOUT_MS });
  if (result.code !== 0) throw new Error(`Cursor Agent exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  let body: { is_error?: boolean; result?: unknown; usage?: unknown };
  try { body = JSON.parse(result.stdout) as typeof body; }
  catch { throw new Error(`Cursor Agent returned no text: ${result.stdout.trim().slice(0, 300)}`); }
  if (body.is_error) throw new Error(`Cursor Agent failed: ${String(body.result ?? "").slice(0, 500)}`);
  if (typeof body.result !== "string") throw new Error(`Cursor Agent returned no text`);
  return { text: body.result.trim(), usage: tokenUsageFromCursor(body.usage) };
}

async function runClaude(model: string | undefined, prompt: string, outputSchema: unknown): Promise<SubscriptionResult> {
  const args = ["-p", "--tools", "", "--output-format", "json"];
  if (model) args.push("--model", model);
  if (outputSchema !== undefined) args.push("--json-schema", JSON.stringify(outputSchema));
  args.push(prompt);
  const result = await runCommand("claude", args, { timeoutMs: CLI_TIMEOUT_MS });
  if (result.code !== 0) throw new Error(`Claude Code exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  let body: { is_error?: boolean; result?: unknown };
  try { body = JSON.parse(result.stdout) as typeof body; }
  catch { throw new Error(`Claude Code returned no text: ${result.stdout.trim().slice(0, 300)}`); }
  if (body.is_error) throw new Error(`Claude Code failed: ${String(body.result ?? "").slice(0, 500)}`);
  if (typeof body.result !== "string") throw new Error(`Claude Code returned no text`);
  return { text: body.result.trim(), usage: tokenUsageFromClaude(body) };
}

async function runCodex(model: string | undefined, prompt: string, outputSchema: unknown): Promise<SubscriptionResult> {
  const dir = await mkdtemp(join(tmpdir(), "orcell-codex-"));
  try {
    const messagePath = join(dir, "message.txt");
    const args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "--json", "-o", messagePath];
    if (model) args.push("-m", model);
    if (outputSchema !== undefined) {
      const schemaPath = join(dir, "schema.json");
      await writeFile(schemaPath, JSON.stringify(outputSchema));
      args.push("--output-schema", schemaPath);
    }
    args.push("-");
    const result = await runCommand("codex", args, { input: prompt, timeoutMs: CLI_TIMEOUT_MS });
    if (result.code !== 0) throw new Error(`Codex exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
    return { text: (await readFile(messagePath, "utf8")).trim(), usage: tokenUsageFromCodexStdout(result.stdout) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function runSubscriptionCli(cli: SubscriptionCli, model: string | undefined, prompt: string, outputSchema: unknown): Promise<SubscriptionResult> {
  await ensureSignedIn(cli);
  const text = promptWithSchema(prompt, outputSchema);
  if (cli === "cursor") return runCursor(model, text);
  if (cli === "claude") return runClaude(model, text, outputSchema);
  return runCodex(model, text, outputSchema);
}
