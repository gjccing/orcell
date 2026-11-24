import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeDependencies, environmentDefinition, selectLoader } from '../dist/loaders/environment.js';
import { parseLlmModel } from '../dist/runners/llm-model.js';
import { tokenUsageFromClaude, tokenUsageFromCodexStdout, tokenUsageFromCursor, tokenUsageFromGateway } from '../dist/runners/token-usage.js';
import { symlink } from 'node:fs/promises';

const cli = resolve('dist/cli.js');

function invoke(command, file, cwd = process.cwd()) {
  return spawnSync(process.execPath, [cli, command, file], { encoding: 'utf8', timeout: 20000, cwd });
}

test('normalizes dependency order and validates map syntax', () => {
  const left = normalizeDependencies('{"z":"2","a":"1"}');
  const right = normalizeDependencies('{"a":"1","z":"2"}');
  assert.deepEqual(left, right);
  assert.throws(() => normalizeDependencies('["not a map"]'));
  assert.throws(() => normalizeDependencies('{"a":12}'));
});

test('only full language names are accepted by the loader', () => {
  const base = { kind: 'code', name: 'sample', source: 'export default () => 1' };
  assert.equal(environmentDefinition({ ...base, lang: 'javascript' }).lang, 'javascript');
  assert.equal(environmentDefinition({ ...base, lang: 'typescript' }).lang, 'typescript');
  assert.throws(() => environmentDefinition({ ...base, lang: 'js' }), /Unsupported language/);
  assert.throws(() => environmentDefinition({ ...base, lang: 'ts' }), /Unsupported language/);
});

test('validate accepts a valid XML and rejects invalid schema', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orcell-test-'));
  const good = join(dir, 'good.xml');
  const bad = join(dir, 'bad.xml');
  await writeFile(good, `<workflow><code name="x" lang="javascript">export default () => 7</code></workflow>`);
  await writeFile(bad, `<workflow><code lang="javascript">export default () => 7</code></workflow>`);
  assert.equal(invoke('validate', good).status, 0);
  assert.notEqual(invoke('validate', bad).status, 0);
  const abbreviated = join(dir, 'abbreviated.xml');
  await writeFile(abbreviated, `<workflow><code name="x" lang="ts">export default () => 7</code></workflow>`);
  assert.notEqual(invoke('validate', abbreviated).status, 0);
});

test('XSD accepts nonempty version strings; Node.js loader validates them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orcell-version-'));
  const source = 'export default () => 7';
  const cell = { kind: 'code', name: 'x', lang: 'typescript', source };
  for (const value of [process.versions.node, '5.9', 'latest', 'v5.9.3']) {
    const file = join(dir, `version-${value}.xml`);
    await writeFile(file, `<workflow><code name="x" lang="typescript" version="${value}">${source}</code></workflow>`);
    assert.equal(invoke('validate', file).status, 0, `XSD should not reject version: ${value}`);
  }
  assert.equal(environmentDefinition({ ...cell, version: process.versions.node }).runtime, `node@${process.versions.node}`);
  assert.equal(environmentDefinition({ ...cell }).runtime, `node@${process.versions.node}`);
  assert.equal(environmentDefinition({ ...cell, version: '20.11.1' }).runtime, 'node@20.11.1');
  assert.throws(() => environmentDefinition({ ...cell, version: 'latest' }), /invalid Node\.js version/);
  assert.throws(() => environmentDefinition({ ...cell, version: '5.9' }), /invalid Node\.js version/);
  assert.throws(() => environmentDefinition({ ...cell, version: 'v5.9.3' }), /invalid Node\.js version/);
});

test('an explicit Node.js version is the process that runs the cell', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orcell-node-'));
  const version = '99.0.1';
  const binDir = join(dir, '.workflow', 'runtimes', 'node', version, 'bin');
  await mkdir(binDir, { recursive: true });
  const nodePath = join(binDir, 'node');
  await writeFile(nodePath, `#!/bin/sh
exec "${process.execPath}" -e 'require("node:fs").writeSync(3, JSON.stringify({ value: "node@${version}" }))'
`);
  await chmod(nodePath, 0o755);
  const workflow = join(dir, 'versioned.xml');
  await writeFile(workflow, `<workflow><code name="x" lang="javascript" version="${version}">export default () => 1</code></workflow>`);
  const run = invoke('run', workflow, dir);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  assert.match(run.stdout, /node@99\.0\.1/);
});

test('run executes cells sequentially, commits state, and reuses environment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orcell-test-'));
  const workflow = join(dir, 'example.xml');
  await writeFile(workflow, `<workflow>
    <code name="first" lang="javascript"><![CDATA[
      export default (wf) => { wf.setState('n', 9); console.log('first'); return 8; };
    ]]></code>
    <code name="second" lang="javascript"><![CDATA[
      export default (wf) => ({ state: wf.getState('n'), previous: wf.getReturn('first') });
    ]]></code>
  </workflow>`);
  const run = invoke('run', workflow, dir);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  assert.match(run.stdout, /"state": 9/);
  assert.match(run.stdout, /"previous": 8/);
  const environmentRoot = join(dir, '.workflow', 'environments');
  assert.equal((await readdir(environmentRoot)).length, 1);
  const logs = (await readdir(join(dir, '.workflow'))).filter((file) => file.endsWith('.log'));
  assert.equal(logs.length, 1);
  const content = await readFile(join(dir, '.workflow', logs[0]), 'utf8');
  assert.match(content, /"event":"context"/);
  assert.match(content, /"event":"return"/);
});

test('language-specific loaders compile JS and TS separately', () => {
  assert.equal(selectLoader('javascript').lang, 'javascript');
  assert.equal(selectLoader('typescript').lang, 'typescript');
  assert.throws(() => selectLoader('python'), /Unsupported language/);
  assert.throws(() => selectLoader('js'), /Unsupported language/);
  assert.throws(() => selectLoader('ts'), /Unsupported language/);
  assert.equal(selectLoader('javascript').compile('export default () => 1', 'x'), 'export default () => 1');
  const compiled = selectLoader('typescript').compile('export default (): number => 2', 'x');
  assert.match(compiled, /export default/);
  assert.doesNotMatch(compiled, /: number/);
});

test('comment markers are excluded from executable source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orcell-test-'));
  const workflow = join(dir, 'annotated.xml');
  await writeFile(workflow, `<workflow>
    <code name="x" lang="javascript"><comment-start id="a"/><![CDATA[export default () => 2;]]><comment-end id="a">not code {{</comment-end></code>
  </workflow>`);
  const run = invoke('run', workflow, dir);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  assert.match(run.stdout, /^2\n$/);
});

test('JS and TS cells share a compatible Node environment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orcell-test-'));
  const workflow = join(dir, 'mixed.xml');
  await writeFile(workflow, `<workflow>
    <code name="js" lang="javascript"><![CDATA[export default (wf) => {wf.setState('a', 4); return 4;}]]></code>
    <code name="ts" lang="typescript"><![CDATA[export default (wf: any): number => wf.getState('a') + 1;]]></code>
  </workflow>`);
  const run = invoke('run', workflow, dir);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const dirs = await readdir(join(dir, '.workflow', 'environments'));
  assert.equal(dirs.length, 1);
});

test('llm model selects a subscription CLI or the AI Gateway', () => {
  assert.deepEqual(parseLlmModel('cursor'), { kind: 'cli', cli: 'cursor' });
  assert.deepEqual(parseLlmModel('claude/sonnet'), { kind: 'cli', cli: 'claude', model: 'sonnet' });
  assert.deepEqual(parseLlmModel('codex/gpt-5.1-codex'), { kind: 'cli', cli: 'codex', model: 'gpt-5.1-codex' });
  assert.deepEqual(parseLlmModel('openai/gpt-4.1-mini'), { kind: 'gateway', model: 'openai/gpt-4.1-mini' });
});

async function fakeCliDir(mode) {
  const dir = await mkdtemp(join(tmpdir(), 'orcell-cli-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const script = join(bin, 'fake-cli.mjs');
  const auth = join(dir, 'auth');
  const log = join(dir, 'log');
  await writeFile(script, `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const bin = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.ORCELL_FAKE_LOG, bin + ' ' + args.map((arg) => JSON.stringify(arg)).join(' ') + '\\n');
const auth = process.env.ORCELL_FAKE_AUTH;
const mode = process.env.ORCELL_FAKE_MODE;
const signedIn = mode === 'ready' || (mode === 'login' && existsSync(auth));
if (bin === 'agent' && args[0] === 'status') {
  process.stdout.write(JSON.stringify({ isAuthenticated: signedIn }));
  process.exit(signedIn ? 0 : 1);
}
if (bin === 'claude' && args[0] === 'auth' && args[1] === 'status') process.exit(signedIn ? 0 : 1);
if (bin === 'codex' && args[0] === 'login' && args[1] === 'status') process.exit(signedIn ? 0 : 1);
if ((bin === 'agent' && args[0] === 'login') || (bin === 'claude' && args[1] === 'login') || (bin === 'codex' && args[0] === 'login')) {
  writeFileSync(auth, 'ok');
  process.exit(0);
}
if (bin === 'agent' && args.includes('--print')) {
  const text = args.at(-1).includes('schema') ? '{"decision":"yes"}' : 'cursor-ok';
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: text, usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0 } }));
  process.exit(0);
}
if (bin === 'claude' && args.includes('-p')) {
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'claude-ok', usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1 } }));
  process.exit(0);
}
if (bin === 'codex' && args[0] === 'exec') {
  const out = args[args.indexOf('-o') + 1];
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { prompt += chunk; });
  process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify({ type: 'token_count', info: { total_token_usage: { input_tokens: 9, cached_input_tokens: 4, output_tokens: 6, reasoning_output_tokens: 2, total_tokens: 19 } } }) + '\\n');
    writeFileSync(out, prompt.includes('schema') ? '{"decision":"yes"}' : 'codex-ok');
    process.exit(0);
  });
}
`);
  await chmod(script, 0o755);
  for (const name of ['agent', 'claude', 'codex']) await symlink(script, join(bin, name));
  return { dir, bin, auth, log, mode };
}

function cliEnv(fake, extra = {}) {
  const env = { ...process.env, ...extra, PATH: `${fake.bin}:${process.env.PATH}`, ORCELL_FAKE_LOG: fake.log, ORCELL_FAKE_AUTH: fake.auth, ORCELL_FAKE_MODE: fake.mode };
  delete env.AI_GATEWAY_API_KEY;
  return env;
}

test('a signed-in subscription CLI answers without an API key', async () => {
  const fake = await fakeCliDir('ready');
  const workflow = join(fake.dir, 'cursor.xml');
  await writeFile(workflow, `<workflow>
    <llm name="ask" model="cursor" key="env:AI_GATEWAY_API_KEY" temperature="0.2"><prompt>hello</prompt></llm>
  </workflow>`);
  const run = spawnSync(process.execPath, [cli, 'run', workflow], { encoding: 'utf8', timeout: 20000, cwd: fake.dir, env: cliEnv(fake) });
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  assert.equal(run.stdout, 'cursor-ok\n');
  const log = await readFile(fake.log, 'utf8');
  assert.match(log, /agent "status"/);
  assert.match(log, /"--mode" "ask"/);
  assert.match(log, /"--output-format" "json"/);
  assert.doesNotMatch(log, /"login"/);
  const usage = (await usageEvents(fake.dir)).find((event) => event.cell === 'ask');
  assert.deepEqual(
    { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens, totalTokens: usage.totalTokens },
    { inputTokens: 11, outputTokens: 7, cachedInputTokens: 3, totalTokens: 21 },
  );
});

test('claude and codex model names are forwarded and JSON output is validated', async () => {
  const fake = await fakeCliDir('ready');
  const claudeFile = join(fake.dir, 'claude.xml');
  const codexFile = join(fake.dir, 'codex.xml');
  await writeFile(claudeFile, `<workflow><llm name="ask" model="claude/sonnet"><prompt>hello</prompt></llm></workflow>`);
  await writeFile(codexFile, `<workflow><llm name="ask" model="codex"><prompt>judge</prompt><output>{"type":"object","properties":{"decision":{"type":"string"}},"required":["decision"],"additionalProperties":false}</output></llm></workflow>`);
  const claude = spawnSync(process.execPath, [cli, 'run', claudeFile], { encoding: 'utf8', timeout: 20000, cwd: fake.dir, env: cliEnv(fake) });
  const codex = spawnSync(process.execPath, [cli, 'run', codexFile], { encoding: 'utf8', timeout: 20000, cwd: fake.dir, env: cliEnv(fake) });
  assert.equal(claude.status, 0, `stderr: ${claude.stderr}`);
  assert.equal(claude.stdout, 'claude-ok\n');
  assert.equal(codex.status, 0, `stderr: ${codex.stderr}`);
  assert.match(codex.stdout, /"decision": "yes"/);
  const log = await readFile(fake.log, 'utf8');
  assert.match(log, /claude "-p".*"--model" "sonnet"/);
  assert.match(log, /codex "exec".*"--json"/);
  const usage = await usageEvents(fake.dir);
  const claudeUsage = usage.find((event) => event.model === 'claude/sonnet');
  const codexUsage = usage.find((event) => event.model === 'codex');
  assert.equal(claudeUsage.inputTokens, 5);
  assert.equal(claudeUsage.cachedInputTokens, 1);
  assert.equal(claudeUsage.totalTokens, 8);
  assert.equal(codexUsage.inputTokens, 9);
  assert.equal(codexUsage.reasoningTokens, 2);
  assert.equal(codexUsage.totalTokens, 19);
});

test('a signed-out subscription CLI fails outside a terminal', async () => {
  const fake = await fakeCliDir('logged-out');
  const workflow = join(fake.dir, 'cursor.xml');
  await writeFile(workflow, `<workflow><llm name="ask" model="cursor"><prompt>hello</prompt></llm></workflow>`);
  const run = spawnSync(process.execPath, [cli, 'run', workflow], { encoding: 'utf8', timeout: 20000, cwd: fake.dir, env: cliEnv(fake) });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /not signed in/);
  assert.match(run.stderr, /agent login/);
  const log = await readFile(fake.log, 'utf8');
  assert.doesNotMatch(log, /"login"/);
});

test('a terminal run logs in and then continues', async () => {
  const fake = await fakeCliDir('login');
  const workflow = join(fake.dir, 'cursor.xml');
  await writeFile(workflow, `<workflow><llm name="ask" model="cursor"><prompt>hello</prompt></llm></workflow>`);
  const env = cliEnv(fake);
  const run = spawnSync('python3', ['-c', `
import os, pty, sys
os.chdir(sys.argv[1])
raise SystemExit(pty.spawn([sys.argv[2], sys.argv[3], "run", sys.argv[4]]) >> 8)
`, fake.dir, process.execPath, cli, workflow], { encoding: 'utf8', timeout: 20000, env });
  assert.equal(run.status, 0, `stderr: ${run.stderr}\nstdout: ${run.stdout}`);
  assert.match(run.stdout, /cursor-ok/);
  const log = await readFile(fake.log, 'utf8');
  assert.match(log, /agent "login"/);
  assert.match(log, /"--print"/);
});

async function usageEvents(dir) {
  const names = (await readdir(join(dir, '.workflow'))).filter((name) => name.endsWith('.log'));
  const events = [];
  for (const name of names) {
    const text = await readFile(join(dir, '.workflow', name), 'utf8');
    for (const line of text.trim().split('\n')) events.push(JSON.parse(line));
  }
  return events.filter((event) => event.event === 'usage');
}

test('token usage is normalized for every LLM backend', () => {
  assert.deepEqual(tokenUsageFromGateway({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } }), {
    inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 2, reasoningTokens: 1,
  });
  assert.deepEqual(tokenUsageFromCursor({ inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 1 }), {
    inputTokens: 11, outputTokens: 7, cachedInputTokens: 4, totalTokens: 22,
  });
  assert.equal(tokenUsageFromClaude({ modelUsage: { 'claude-sonnet': { inputTokens: 3, outputTokens: 1, cacheReadInputTokens: 2, cacheCreationInputTokens: 0 } } }).totalTokens, 6);
  assert.equal(tokenUsageFromCodexStdout('{"type":"token_count","info":{"total_token_usage":{"input_tokens":9,"cached_input_tokens":4,"output_tokens":6,"total_tokens":19}}}\n').totalTokens, 19);
});

test('an AI Gateway model still requires its API key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orcell-test-'));
  const workflow = join(dir, 'gateway.xml');
  await writeFile(workflow, `<workflow><llm name="ask" model="openai/gpt-4.1-mini"><prompt>hello</prompt></llm></workflow>`);
  const env = { ...process.env };
  delete env.AI_GATEWAY_API_KEY;
  const run = spawnSync(process.execPath, [cli, 'run', workflow], { encoding: 'utf8', timeout: 20000, cwd: dir, env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Missing API key environment variable: AI_GATEWAY_API_KEY/);
});
