import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import type { CodeCell } from "../core/types.js";
import { jsLoader } from "./js.js";
import { workflowDir } from "../core/paths.js";
import { nodeExecutable } from "./node-runtime.js";
import { tsLoader } from "./ts.js";
import type { CodeLanguageLoader } from "./types.js";

export interface EnvironmentDefinition {
  lang: "javascript" | "typescript";
  version: string | null;
  runtime: string;
  compiler: string | null;
  platform: string;
  architecture: string;
  dependencies: Record<string, string>;
}

export interface PreparedEnvironment {
  hash: string;
  path: string;
  definition: EnvironmentDefinition;
  execPath: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeDependencies(raw?: string): Record<string, string> {
  if (raw === undefined) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("@dependencies must be a JSON object mapping package names to versions"); }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("@dependencies must be a JSON object mapping package names to versions");
  }
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, spec] of Object.entries(parsed)) {
    // Package names can be scoped (@scope/name), but must not contain URL or path segments.
    if (!/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) {
      throw new Error(`Invalid npm package name '${name}'`);
    }
    if (typeof spec !== "string" || !spec.trim()) throw new Error(`Invalid version for dependency '${name}'`);
    result[name] = spec.trim();
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

export function selectLoader(lang: string): CodeLanguageLoader {
  switch (lang.toLowerCase()) {
    case "javascript":
      return jsLoader;
    case "typescript":
      return tsLoader;
    default:
      throw new Error(`Unsupported language '${lang}'; use 'javascript' or 'typescript'`);
  }
}

export function environmentDefinition(cell: CodeCell): EnvironmentDefinition {
  const loader = selectLoader(cell.lang);
  const version = cell.version?.trim() || null;
  // For both JavaScript and TypeScript, @version means the Node.js runtime version.
  // The TypeScript compiler is selected by the TS loader, independent of @version.
  if (version && !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Cell '${cell.name}' has an invalid Node.js version '${version}' (expected major.minor.patch)`);
  }
  return {
    lang: loader.lang,
    version,
    runtime: `node@${version ?? process.versions.node}`,
    compiler: loader.compiler,
    platform: process.platform,
    architecture: process.arch,
    dependencies: normalizeDependencies(cell.dependencies),
  };
}

function runNpm(cwd: string, nodeExec: string): Promise<void> {
  const bundled = nodeExec !== process.execPath;
  const npmCli = process.platform === "win32"
    ? join(dirname(nodeExec), "node_modules", "npm", "bin", "npm-cli.js")
    : join(dirname(nodeExec), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const command = bundled ? nodeExec : (process.platform === "win32" ? "npm.cmd" : "npm");
  const args = bundled
    ? [npmCli, "install", "--no-audit", "--no-fund", "--package-lock=true"]
    : ["install", "--no-audit", "--no-fund", "--package-lock=true"];
  const env = bundled
    ? { ...process.env, PATH: `${dirname(nodeExec)}${delimiter}${process.env.PATH ?? ""}` }
    : process.env;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd, env, stdio: ["ignore", "inherit", "inherit"], shell: !bundled && process.platform === "win32",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`npm install failed (code=${code}, signal=${signal}) in '${cwd}'`));
    });
  });
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch { return false; }
}

/** On-demand, configuration-keyed environment shared by compatible cells in a workflow directory. */
export class EnvironmentLoader {
  async prepare(cell: CodeCell): Promise<PreparedEnvironment> {
    const definition = environmentDefinition(cell);
    const execPath = await nodeExecutable(definition.version);
    // JS and TS use the same Node/npm environment; transpilation is cell-specific.
    // Cache by the actual execution environment, not the cell source language.
    // TODO: share one environment across cells with compatible Node version and dependency ranges.
    // Today the key is an exact match. See README.md.
    const canonical = canonicalJson({
      runtime: definition.runtime,
      platform: definition.platform,
      architecture: definition.architecture,
      dependencies: definition.dependencies,
    });
    const hash = sha256(canonical);
    const path = resolve(workflowDir(), "environments", hash);
    const ready = join(path, ".ready.json");
    if (await fileExists(ready)) {
      const previous = JSON.parse(await readFile(ready, "utf8")) as { definition?: string };
      if (previous.definition === canonical) return { hash, path, definition, execPath };
    }

    await mkdir(path, { recursive: true });
    const dependencies = definition.dependencies;
    const manifest = {
      name: `orcell-env-${hash.slice(0, 16)}`,
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies,
    };
    await writeFile(join(path, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

    // Avoid npm startup for dependency-free environments.
    if (Object.keys(dependencies).length > 0) {
      await runNpm(path, execPath);
      // npm install writes package-lock.json, which locks resolved transitive versions.
      if (!(await fileExists(join(path, "package-lock.json")))) {
        throw new Error(`Environment '${hash}' did not produce a package-lock.json`);
      }
    }
    await writeFile(ready, JSON.stringify({ definition: canonical, createdAt: new Date().toISOString() }) + "\n");
    return { hash, path, definition, execPath };
  }
}

/** Each cell's compiled module lives under its environment, so Node can find node_modules. */
export async function compileCell(cell: CodeCell, environment: PreparedEnvironment): Promise<string> {
  const hash = sha256(canonicalJson({ source: cell.source, lang: environment.definition.lang, compiler: environment.definition.compiler }));
  const filePath = join(environment.path, "cells", `${hash}.mjs`);
  if (await fileExists(filePath)) return filePath;
  await mkdir(dirname(filePath), { recursive: true });

  const loader = selectLoader(cell.lang);
  const compiled = loader.compile(cell.source, cell.name);
  await writeFile(filePath, compiled);
  return filePath;
}
