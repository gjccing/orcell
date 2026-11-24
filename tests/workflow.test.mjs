import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeDependencies, environmentDefinition, selectLoader } from '../dist/loaders/environment.js';

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
