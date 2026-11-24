import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { workflowDir } from "../core/paths.js";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function nodeArchiveName(version: string): string {
  const platform = process.platform === "win32" ? "win" : process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win") {
    throw new Error(`Unsupported platform '${process.platform}' for Node.js ${version}`);
  }
  const arch = process.arch === "arm" ? "armv7l" : process.arch === "ppc64" ? "ppc64le" : process.arch;
  const extension = process.platform === "win32" ? "zip" : "tar.gz";
  return `node-v${version}-${platform}-${arch}.${extension}`;
}

function checksumFor(sums: string, archive: string): string {
  for (const line of sums.split("\n")) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match?.[2] === archive) return match[1];
  }
  throw new Error(`Node.js archive '${archive}' is not published for this platform`);
}

async function downloadFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed for ${url} (${response.status})`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function installNode(version: string, root: string): Promise<void> {
  const archive = nodeArchiveName(version);
  const base = `https://nodejs.org/dist/v${version}`;
  const staging = `${root}.partial`;
  const archivePath = join(tmpdir(), `orcell-${archive}`);
  const sumsPath = `${archivePath}.sha`;
  process.stderr.write(`Preparing Node.js ${version}\n`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await downloadFile(`${base}/SHASUMS256.txt`, sumsPath);
    const expected = checksumFor(await readFile(sumsPath, "utf8"), archive);
    await downloadFile(`${base}/${archive}`, archivePath);
    const actual = createHash("sha256").update(await readFile(archivePath)).digest("hex");
    if (actual !== expected) throw new Error(`Checksum mismatch for ${archive}`);
    await execFileAsync("tar", ["-xf", archivePath, "-C", staging, "--strip-components=1"]);
    await rm(root, { recursive: true, force: true });
    await rename(staging, root);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw new Error(`Unable to provision Node.js ${version}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(archivePath, { force: true });
    await rm(sumsPath, { force: true });
  }
}

/** Node binary for a cell. An omitted version, or the version already running Orcell, uses this process. */
export async function nodeExecutable(version: string | null): Promise<string> {
  if (!version || version === process.versions.node) return process.execPath;
  const root = resolve(workflowDir(), "runtimes", "node", version);
  const executable = join(root, process.platform === "win32" ? "node.exe" : "bin/node");
  try { await access(executable); return executable; }
  catch { /* download the official build into the workflow cache */ }
  await installNode(version, root);
  try { await access(executable); }
  catch { throw new Error(`Node.js ${version} did not provide '${executable}'`); }
  return executable;
}
