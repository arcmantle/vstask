import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { render } from '@inquirer/testing';
import { discoverTaskFiles } from '../packages/core/dist/index.js';
import * as cliAdapter from '../packages/cli/dist/index.js';
import { resolveVSCodeTaskPlan } from '../packages/vscode-extension/dist/extension.js';
import { baselineResolver } from './upstream-variable-resolver.mjs';

const cli = fileURLToPath(new URL('../packages/cli/dist/index.js', import.meta.url));
const launcher = fileURLToPath(new URL('../packages/cli/bin/launch.cjs', import.meta.url));

async function waitFor(check) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try { return await check(); }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function cancellationFixture(context) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vstask-cancel-')));
  const pids = join(root, 'pids');
  const worker = join(root, 'tree.cjs');
  const file = join(root, '.vscode', 'tasks.json');
  await mkdir(join(root, '.vscode'));
  await writeFile(worker, `const { spawn } = require('node:child_process');
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');
process.on('SIGTERM', () => {});
if (Number(process.argv[2]) > 0) spawn(process.execPath, [__filename, String(Number(process.argv[2]) - 1), process.argv[3] || ''], {
  stdio: process.argv[3] === 'separate' ? 'ignore' : 'inherit', detached: process.argv[3] === 'separate',
});
setInterval(() => {}, 1000);
`);
  const definitions = ['process', 'shell'].flatMap(type => ['inherited', 'separate'].map(group => ({
    label: group === 'inherited' ? type : `${type} separate`, type, command: process.execPath,
    args: [worker, '2', group], options: { cwd: root },
  })));
  await writeFile(file, JSON.stringify({ version: '2.0.0', tasks: definitions }));
  const control = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(() => {},1000);']);
  const controlClosed = once(control, 'close');
  await once(control.stdout, 'data');
  const owned = async () => (await readFile(pids, 'utf8')).trim().split('\n').map(Number);
  context.after(async () => {
    for (const pid of await owned().catch(() => [])) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    control.kill('SIGKILL');
    await controlClosed;
    await rm(root, { recursive: true, force: true });
  });
  return { root, file, pids, control, owned, ready: () => waitFor(async () => {
    const processes = await owned();
    assert.equal(processes.length, 3);
    assert.ok(processes.every(isRunning));
    return processes;
  }) };
}

async function runtimeFixture(context) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vstask-runtime-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const probe = join(root, 'runtime probe.cjs');
  await writeFile(probe, `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write(process.env.PROBE_VERSION_FILE ? fs.readFileSync(process.env.PROBE_VERSION_FILE, 'utf8') : process.env.PROBE_VERSION); }
else if (args.includes(process.env.PROBE_LAUNCHER)) { const child = require('node:child_process').spawnSync(process.execPath, args.slice(args.indexOf(process.env.PROBE_LAUNCHER)), { stdio: 'inherit' }); process.exit(child.status || 0); }
else { fs.appendFileSync(process.env.PROBE_STARTS, JSON.stringify(args) + '\\n'); process.stdout.write('task output'); process.exit(Number(process.env.PROBE_EXIT || 0)); }
`);
  async function executable(name, version) {
    const file = join(root, name);
    if (version !== undefined) await writeFile(`${file}.version`, version);
    await writeFile(file, `#!/bin/sh\n${version === undefined ? '' : `PROBE_VERSION_FILE=${JSON.stringify(`${file}.version`)} `}exec ${JSON.stringify(process.execPath)} ${JSON.stringify(probe)} "$@"\n`, { mode: 0o755 });
    return file;
  }
  return { root, executable, starts: join(root, 'starts'), env: { ...process.env,
    PATH: root, VSTASK_RUNTIME: '', PROBE_LAUNCHER: launcher,
    PROBE_STARTS: join(root, 'starts'), PROBE_VERSION: 'v22.16.0' } };
}

test('launcher uses an explicit supported executable and preserves one startup and its exit status', {
  skip: process.platform === 'win32' && 'Controlled executable fixtures use POSIX scripts; Windows is a separate runtime gate.',
}, async context => {
  const fixture = await runtimeFixture(context);
  const executable = await fixture.executable('chosen runtime');
  const args = ['run', 'two words', '--input', 'value=a=b'];
  const result = spawnSync(process.execPath, [launcher, ...args], { encoding: 'utf8',
    env: { ...fixture.env, VSTASK_RUNTIME: executable, PROBE_EXIT: '23' } });
  assert.equal(result.status, 23, result.stderr);
  assert.equal(result.stdout, 'task output');
  assert.match(result.stderr, /Node\.js 22\.16\.0/u);
  assert.ok(result.stderr.includes(executable));
  const { readFile } = await import('node:fs/promises');
  assert.deepEqual((await readFile(fixture.starts, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), [[cli, ...args]]);
});

test('launcher rejects missing, unsupported, and prerelease explicit runtimes without PATH fallback or task startup', {
  skip: process.platform === 'win32' && 'Controlled executable fixtures use POSIX scripts; Windows is a separate runtime gate.',
}, async context => {
  const fixture = await runtimeFixture(context);
  await fixture.executable('node', 'v24.0.0');
  for (const version of [undefined, 'v22.15.9', 'v20.19.0', 'v23.1.0', 'v24.0.0-rc.1', '1.1.99', 'deno 2.3.9\nv8 13.5', 'unrelated tool']) {
    const executable = version === undefined ? join(fixture.root, 'missing') : await fixture.executable('explicit', version);
    const result = spawnSync(process.execPath, [launcher, 'run', 'probe'], {
      encoding: 'utf8', env: { ...fixture.env, VSTASK_RUNTIME: executable },
    });
    assert.equal(result.status, 1, `${version}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /missing or unsupported/u);
    assert.match(result.stderr, /Install.*Node\.js.*Bun.*Deno/u);
  }
  const { access } = await import('node:fs/promises');
  await assert.rejects(access(fixture.starts), { code: 'ENOENT' });
});

test('launcher selects the first supported PATH runtime in Node.js, Bun, Deno order before one startup', {
  skip: process.platform === 'win32' && 'Controlled executable fixtures use POSIX scripts; Windows is a separate runtime gate.',
}, async context => {
  const { readFile, access } = await import('node:fs/promises');
  for (const [versions, family, version, prefix] of [
    [['v24.0.0', '1.2.0', 'deno 2.4.0\nv8 13.7'], 'Node.js', '24.0.0', []],
    [['v22.16.0', '1.2.0', 'deno 2.4.0'], 'Node.js', '22.16.0', []],
    [['v22.15.9', '1.2.0', 'deno 2.4.0'], 'Bun', '1.2.0', []],
    [[undefined, '1.1.99', 'deno 2.4.0\nv8 13.7\ntypescript 5.8'], 'Deno', '2.4.0', ['run', '--allow-all', '--no-prompt', '--quiet']],
    [['v23.0.0', '1.2.0-beta.1', 'deno 2.4.0-rc.1'], undefined, undefined, []],
    [[undefined, undefined, undefined], undefined, undefined, []],
  ]) {
    const fixture = await runtimeFixture(context);
    for (const [index, name] of ['node', 'bun', 'deno'].entries()) {
      if (versions[index]) await fixture.executable(name, versions[index]);
    }
    const result = spawnSync(process.execPath, [launcher, 'list', '--workspace', 'two words'], {
      encoding: 'utf8', env: fixture.env,
    });
    if (family) {
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stderr.includes(`${family} ${version}`), result.stderr);
      assert.equal(result.stdout, 'task output');
      assert.deepEqual((await readFile(fixture.starts, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
        [[...prefix, cli, 'list', '--workspace', 'two words']]);
    } else {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Install.*Node\.js.*Bun.*Deno/u);
      assert.equal(result.stdout, '');
      await assert.rejects(access(fixture.starts), { code: 'ENOENT' });
    }
  }
});

test('platform entry applies selector policy without Node.js or retries after task startup', {
  skip: process.platform === 'win32' && 'The Windows entry requires the Windows runtime integration gate.',
}, async context => {
  const { readFile, access } = await import('node:fs/promises');
  const entry = fileURLToPath(new URL('../packages/cli/bin/vstask', import.meta.url));
  for (const [name, version, prefix] of [['bun', '1.2.0', []],
    ['deno', 'deno 2.4.0', ['run', '--allow-all', '--no-prompt', '--quiet']]]) {
    const fixture = await runtimeFixture(context);
    await fixture.executable(name, version);
    const result = spawnSync('/bin/sh', [entry, 'run', 'task with spaces', '--input', 'empty='], {
      encoding: 'utf8', env: { ...fixture.env, PROBE_EXIT: '29' },
    });
    assert.equal(result.status, 29, result.stderr);
    assert.equal(result.stdout, 'task output');
    assert.ok(result.stderr.includes(name === 'bun' ? 'Bun 1.2.0' : 'Deno 2.4.0'), result.stderr);
    assert.deepEqual((await readFile(fixture.starts, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
      [[...prefix, cli, 'run', 'task with spaces', '--input', 'empty=']]);
  }
  for (const [versions, explicit, selected] of [
    [['v23.0.0', '1.2.0'], undefined, 'Bun 1.2.0'],
    [['v12.0.0', '1.2.0'], undefined, 'Bun 1.2.0'],
    [['v20.0.0', '1.1.99', 'deno 2.3.9'], undefined, undefined],
    [['v23.0.0', '1.2.0'], 'node', undefined],
    [['v24.0.0', '1.2.0'], 'missing', undefined],
    [[], undefined, undefined],
  ]) {
    const fixture = await runtimeFixture(context);
    for (const [index, name] of ['node', 'bun', 'deno'].entries()) {
      if (versions[index]) await fixture.executable(name, versions[index]);
    }
    const result = spawnSync('/bin/sh', [entry, 'run', 'probe'], { encoding: 'utf8',
      env: { ...fixture.env, VSTASK_RUNTIME: explicit ? join(fixture.root, explicit) : '', PROBE_EXIT: '29' } });
    assert.equal(result.status, selected ? 29 : 1, result.stderr);
    if (selected) {
      assert.ok(result.stderr.includes(selected), result.stderr);
      assert.deepEqual((await readFile(fixture.starts, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), [[cli, 'run', 'probe']]);
    } else {
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Install.*Node\.js.*Bun.*Deno/u);
      await assert.rejects(access(fixture.starts), { code: 'ENOENT' });
    }
  }
});

test('CLI runs a configured shell with quoted arguments and the shared process streams', async context => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vstask-shell-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'run folder');
  await mkdir(join(root, '.vscode'));
  await mkdir(cwd);
  const file = join(root, '.vscode', 'tasks.json');
  const probe = join(root, 'shell probe.cjs');
  await writeFile(probe, 'let input="";process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),inherited:process.env.VSTASK_INHERITED,override:process.env.VSTASK_OVERRIDE,input}));process.stderr.write("shell stderr\\n");});');
  await writeFile(file, JSON.stringify({ version: '2.0.0', tasks: [{
    label: 'shell probe', type: 'shell', command: process.execPath,
    args: [probe, 'two words', '""', { value: '$HOME; echo wrong', quoting: 'strong' }],
    options: { cwd: 'run folder', env: { VSTASK_OVERRIDE: '${env:VSTASK_INHERITED}-task' },
      shell: process.platform === 'win32' ? { executable: 'cmd.exe', args: ['/d', '/c'] }
        : { executable: '/bin/bash', args: ['-c'] } },
  }] }));
  const result = spawnSync(process.execPath, [cli, 'run', 'shell probe', '--file', file], {
    encoding: 'utf8', input: 'shell standard input',
    env: { ...process.env, VSTASK_INHERITED: 'parent', VSTASK_OVERRIDE: 'parent' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    argv: ['two words', '', '$HOME; echo wrong'], cwd, inherited: 'parent', override: 'parent-task', input: 'shell standard input',
  });
  assert.equal(result.stderr, 'shell stderr\n');
});

test('both adapters retain pinned shell quoting, command-only rules, and inherited shell options', {
  skip: process.platform === 'win32' && 'The launch capture uses POSIX argv handling; Windows uses real shell probes.',
}, async context => {
  const core = await import('@vstask/core');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vstask-shell-launch-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, '.vscode', 'tasks.json');
  await writeFile(join(root, 'capture.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const executables = new Set();
  for (const [platform, name, command, args, quoting, expected] of [
    ['darwin', 'bash', 'tool', ['two words', '""', '"already quoted"'], undefined, 'tool \'two words\' "" "already quoted"'],
    ['darwin', 'bash', 'tool', ['', { value: '', quoting: 'strong' }, { value: [], quoting: 'weak' }, ['joined', 'words']], undefined, "tool  'joined words'"],
    ['darwin', 'zsh', 'tool', [{ value: 'a "b"', quoting: 'escape' }, { value: '$VALUE', quoting: 'weak' }], undefined, 'tool a\\ \\"b\\" "$VALUE"'],
    ['darwin', 'bash', 'tool && other', [], undefined, 'tool && other'],
    ['darwin', 'bash', '${env:TOOL}', [], undefined, "'tool with spaces'"],
    ['darwin', 'bash', ['tool', 'with spaces'], [], undefined, 'tool with spaces'],
    ['darwin', 'bash', 'tool', [{ value: 'two words', quoting: 'escape' }], { escape: '^' }, 'tool two^ words'],
    ['darwin', 'bash', 'tool', [{ value: 'x;y', quoting: 'escape' }], { escape: { escapeChar: '\\', charsToEscape: ';' } }, 'tool x\\;y'],
    ['win32', 'cmd.exe', 'tool with spaces', ['two words'], undefined, '""tool with spaces" "two words""'],
    ['win32', 'powershell.exe', 'tool with spaces', ['two words'], undefined, "& 'tool with spaces' 'two words'"],
    ['win32', 'pwsh.exe', 'tool', [{ value: 'a (b)', quoting: 'escape' }, { value: '$VALUE', quoting: 'weak' }], undefined, 'tool a` `(b`) "$VALUE"'],
  ]) {
    const executable = join(root, name);
    if (!executables.has(executable)) {
      if (process.platform === 'win32') {
        await copyFile(process.execPath, executable);
        await chmod(executable, 0o755);
      } else {
        await symlink(process.execPath, executable);
      }
      executables.add(executable);
    }
    const task = core.identifyTask(root, core.parseTaskFile(JSON.stringify({ version: '2.0.0',
      options: { shell: { executable, args: ['must-not-run.cjs'] } }, tasks: [{ label: 'probe', type: 'shell',
        command, args, options: { shell: { args: ['must-not-run.cjs'], ...(quoting ? { quoting } : {}) } },
        osx: { options: { shell: { args: ['capture.cjs'] } } },
        windows: { options: { shell: { args: ['capture.cjs'] } } },
      }] }), file).tasks[0]);
    for (const prepare of [cliAdapter.resolveCliTaskPlan, resolveVSCodeTaskPlan]) {
      const plan = await prepare([task], task, { platform, environment: { ...process.env, TOOL: 'tool with spaces' } });
      const output = [];
      const result = await core.runProcessTask(plan.task, { platform,
        onEvent: event => { if (event.type === 'output') output.push(event.data); } });
      assert.equal(result.status, 'success', `${name}: ${JSON.stringify(result)} ${Buffer.concat(output).toString()}`);
      assert.deepEqual(JSON.parse(Buffer.concat(output).toString()), [expected]);
      if (name === 'cmd.exe') {
        const events = [];
        assert.throws(() => core.runProcessTask({ ...plan.task,
          configuration: { ...plan.task.configuration, options: { ...plan.task.configuration.options, cwd: '' } },
        }, { platform, userHome: '\\\\server\\share', onEvent: event => events.push(event) }), /cmd.*UNC/u);
        assert.deepEqual(events, []);
      }
    }
  }
});

test('shared shell probes execute quoting modes and command-only expressions in real platform shells', async context => {
  const core = await import('@vstask/core');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vstask-shell-quoting-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const probe = join(root, 'argument probe.cjs');
  await writeFile(probe, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const file = join(root, '.vscode', 'tasks.json');
  const shells = process.platform === 'win32'
    ? [{ executable: 'cmd.exe', args: ['/d', '/c'] }, { executable: 'powershell.exe', args: ['-NoProfile', '-Command'] }]
    : [{ executable: '/bin/bash', args: ['-c'] }, { executable: '/bin/zsh', args: ['-c'] }];
  for (const shell of shells) {
    const powershell = shell.executable === 'powershell.exe';
    for (const commandOnly of [false, true]) {
      const quoted = value => ({ value, quoting: 'strong' });
      const task = core.identifyTask(root, core.parseTaskFile(JSON.stringify({ tasks: [{
        label: 'probe', isShellCommand: true,
        command: commandOnly ? (powershell ? 'Write-Output expression; Write-Output complete'
          : process.platform === 'win32' ? 'echo expression && echo complete' : 'printf expression | cat') : process.execPath,
        args: commandOnly ? [] : [probe, 'two words', powershell ? quoted('""') : '""', quoted('metachar; | & ()'),
          ...(process.platform === 'win32' ? [] : [quoted('$VSTASK_EXPAND'), { value: '$VSTASK_EXPAND', quoting: 'weak' },
            { value: 'a "b"', quoting: 'escape' }])],
        options: { shell, env: { VSTASK_EXPAND: 'expanded' } },
      }] }), file).tasks[0]);
      const plan = await cliAdapter.resolveCliTaskPlan([task], task);
      const output = [];
      const result = await core.runProcessTask(plan.task, {
        onEvent: event => { if (event.type === 'output') output.push(event.data); },
      });
      const text = Buffer.concat(output).toString();
      assert.equal(result.status, 'success', `${shell.executable}: ${text}`);
      if (commandOnly) {
        assert.match(text, process.platform === 'win32' ? /expression\r?\ncomplete/u : /^expression$/u);
      } else {
        assert.deepEqual(JSON.parse(text), ['two words', '', 'metachar; | & ()',
          ...(process.platform === 'win32' ? [] : ['$VSTASK_EXPAND', 'expanded', 'a "b"'])]);
      }
    }
  }
});

test('a cancelled run starts no process and reports cancellation once', async () => {
  const core = await import('@vstask/core');
  const root = process.cwd();
  const task = core.identifyTask(root, core.parseTaskFile(JSON.stringify({ tasks: [{
    label: 'cancelled', type: 'process', command: process.execPath, args: ['-e', 'process.exit(0)'],
  }] }), join(root, '.vscode', 'tasks.json')).tasks[0]);
  const plan = await cliAdapter.resolveCliTaskPlan([task], task);
  const controller = new AbortController();
  controller.abort();
  const events = [];
  const result = await core.runProcessTask(plan.task, { signal: controller.signal, onEvent: event => events.push(event) });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.exitCode, null);
  assert.deepEqual(events.map(event => event.type), ['complete']);
  assert.equal(events[0].result, result);
});

test('cancellation stops an owned process or shell tree before completion and keeps unrelated work active', async context => {
  const core = await import('@vstask/core');
  const fixture = await cancellationFixture(context);
  const tasks = core.parseTaskFile(await readFile(fixture.file, 'utf8'), fixture.file).tasks
    .map(task => core.identifyTask(fixture.root, task));
  for (const task of tasks) {
    await rm(fixture.pids, { force: true });
    const plan = await cliAdapter.resolveCliTaskPlan(tasks, task);
    const controller = new AbortController();
    const events = [];
    const running = core.runProcessTask(plan.task, { signal: controller.signal, onEvent: event => events.push(event) });
    const owned = await fixture.ready();
    controller.abort();
    controller.abort();
    const fallback = setTimeout(() => { for (const pid of owned) { try { process.kill(pid, 'SIGKILL'); } catch {} } }, 1500);
    let result;
    try { result = await running; } finally { clearTimeout(fallback); }
    assert.equal(result.status, 'cancelled', `${task.label}: ${JSON.stringify(result)}`);
    assert.equal(result.exitCode, null);
    assert.equal(events.filter(event => event.type === 'complete').length, 1);
    assert.equal(events.filter(event => event.type === 'start').length, 1, 'Cancellation does not restart the task.');
    assert.ok(owned.every(pid => !isRunning(pid)), 'Completion follows owned-tree cleanup.');
    assert.ok(isRunning(fixture.control.pid), 'An unrelated process remains active.');
  }
});

test('cleanup errors preserve cancellation and do not prevent remaining owned cleanup', async context => {
  const core = await import('@vstask/core');
  const fixture = await cancellationFixture(context);
  const task = core.identifyTask(fixture.root, core.parseTaskFile(await readFile(fixture.file, 'utf8'), fixture.file).tasks[0]);
  const plan = await cliAdapter.resolveCliTaskPlan([task], task);
  const controller = new AbortController();
  const events = [];
  const running = core.runProcessTask(plan.task, { signal: controller.signal, onEvent: event => events.push(event) });
  const owned = await fixture.ready();
  const kill = process.kill;
  context.mock.method(process, 'kill', (pid, signal) => {
    if (pid < 0 && signal === 'SIGKILL') throw Object.assign(new Error('private cleanup detail'), { code: 'EPERM' });
    return kill.call(process, pid, signal);
  });
  controller.abort();
  let fallbackUsed = false;
  const fallback = setTimeout(() => {
    fallbackUsed = true;
    for (const pid of owned) { try { kill.call(process, pid, 'SIGKILL'); } catch {} }
  }, 1500);
  let result;
  try { result = await running; } finally { clearTimeout(fallback); }
  assert.equal(result.status, 'cancelled');
  assert.equal(result.exitCode, null);
  assert.match(result.error, /Cannot stop owned processes/u);
  assert.doesNotMatch(JSON.stringify(events), /private cleanup detail/u);
  assert.equal(events.filter(event => event.type === 'error').length, 1);
  assert.equal(events.filter(event => event.type === 'complete').length, 1);
  assert.equal(fallbackUsed, false, 'Cleanup attempts continue after a group signal error.');
  assert.ok(owned.every(pid => !isRunning(pid)));
  assert.ok(isRunning(fixture.control.pid));
});

test('CLI interruption cleans owned descendants and reports cancellation without stopping unrelated work', {
  skip: process.platform === 'win32' && 'Windows console signals require the Windows integration gate.',
}, async context => {
  const fixture = await cancellationFixture(context);
  for (const [signal, type, expectedCode] of [['SIGINT', 'process', 130], ['SIGTERM', 'shell', 143]]) {
    await rm(fixture.pids, { force: true });
    const child = spawn(process.execPath, [cli, 'run', type, '--file', fixture.file]);
    context.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const output = [];
    const errors = [];
    child.stdout.on('data', data => output.push(data));
    child.stderr.on('data', data => errors.push(data));
    const closed = once(child, 'close');
    const owned = await fixture.ready();
    child.kill(signal);
    const [exitCode, exitSignal] = await closed;
    assert.equal(exitCode, expectedCode);
    assert.equal(exitSignal, null);
    assert.equal(Buffer.concat(output).toString(), '');
    assert.match(Buffer.concat(errors).toString(), /cancelled/iu);
    assert.ok(owned.every(pid => !isRunning(pid)), 'CLI exit follows owned-tree cleanup.');
    assert.ok(isRunning(fixture.control.pid), 'An unrelated process remains active.');
  }
});

test('CLI runs a selected process with exact arguments, task cwd, environment, and streams', async context => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vstask-process-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project with spaces');
  const cwd = join(project, 'run folder');
  await mkdir(join(project, '.vscode'), { recursive: true });
  await mkdir(cwd);
  const file = join(project, '.vscode', 'tasks.json');
  const probe = 'let input="";process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),inherited:process.env.VSTASK_INHERITED,override:process.env.VSTASK_OVERRIDE,input}));process.stderr.write("probe stderr\\n");});';
  const argumentsToPass = ['two words', '', '"quoted"', '$HOME; echo wrong', 'Unicode: \u00e6'];
  await writeFile(file, JSON.stringify({ version: '2.0.0', inputs: [
    { id: 'value', type: 'promptString', description: 'Value' },
  ], tasks: [
    { label: 'probe', type: 'process', command: process.execPath,
      args: ['-e', probe, ...argumentsToPass, '${input:value}'],
      options: { cwd: 'run folder', env: { VSTASK_OVERRIDE: '${env:VSTASK_INHERITED}-task' } } },
    { label: 'unused', type: 'process', command: '${input:missing}' },
  ] }));
  const result = spawnSync(process.execPath, [cli, 'run', 'probe', '--workspace', root, '--input', 'value=supplied=value'], {
    encoding: 'utf8', input: 'CLI standard input', env: { ...process.env, VSTASK_INHERITED: 'parent', VSTASK_OVERRIDE: 'parent' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    argv: [...argumentsToPass, 'supplied=value'], cwd, inherited: 'parent', override: 'parent-task', input: 'CLI standard input',
  });
  assert.equal(result.stderr, 'probe stderr\n');
});

test('both adapter preparations apply process platform overrides before variables and startup', async context => {
  const core = await import('@vstask/core');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vstask-platform-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'selected folder'));
  const file = join(root, '.vscode', 'tasks.json');
  const probe = 'process.stdout.write(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),common:process.env.COMMON,platform:process.env.PLATFORM,overrides:Object.entries(process.env).filter(([key])=>key.toLowerCase()==="vstask_override")}));';
  const overrides = platform => ({ command: [process.execPath],
    args: ['-e', probe, { value: ['joined', 'words'], quoting: 'strong' }, '', '${env:PLATFORM_VALUE}'],
    options: { cwd: '${workspaceFolder}/selected folder', env: { PLATFORM: '${env:PLATFORM_VALUE}',
      [platform === 'win32' ? 'vstask_override' : 'VSTASK_OVERRIDE']: platform } } });
  const task = core.identifyTask(root, core.parseTaskFile(JSON.stringify({ version: '2.0.0', tasks: [{
    label: 'probe', type: 'process', command: 'base-command-must-not-run', args: ['base-argument'],
    options: { cwd: 'missing folder', env: { COMMON: 'base', VSTASK_OVERRIDE: 'base' } },
    osx: overrides('darwin'), windows: overrides('win32'),
  }] }), file).tasks[0]);
  for (const platform of ['darwin', 'win32']) {
    for (const prepare of [cliAdapter.resolveCliTaskPlan, resolveVSCodeTaskPlan]) {
      const environment = { ...process.env, VSTASK_OVERRIDE: 'inherited', PLATFORM_VALUE: platform };
      const plan = await prepare([task], task, { platform, environment });
      const output = [];
      const result = await core.runProcessTask(plan.task, { platform, environment,
        onEvent: event => { if (event.type === 'output' && event.stream === 'stdout') output.push(event.data); } });
      assert.equal(result.status, 'success', result.error);
      const report = JSON.parse(Buffer.concat(output).toString());
      assert.deepEqual(report.argv, ['joined words', '', platform]);
      assert.equal(report.cwd, join(root, 'selected folder'));
      assert.equal(report.common, 'base');
      assert.equal(report.platform, platform);
      assert.deepEqual(report.overrides.map(([, value]) => value), [platform]);
    }
  }
  assert.equal(task.configuration.command, 'base-command-must-not-run');
});

test('shared execution reports streams and one final result after success, failure, or startup errors', async context => {
  const core = await import('@vstask/core');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vstask-lifecycle-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, '.vscode', 'tasks.json');
  for (const type of ['process', 'shell']) {
  for (const [command, args, options, expected] of [
    [process.execPath, ['-e', 'process.stdin.on("data",chunk=>process.stdout.write(chunk));process.stdin.on("end",()=>process.stderr.write("stderr"));'], {}, { status: 'success', exitCode: 0 }],
    [process.execPath, ['-e', 'process.stdout.write("last output");process.stderr.write("failure");process.exitCode=17;'], {}, { status: 'failed', exitCode: 17 }],
    [join(root, 'missing executable'), [], {}, { status: 'failed', exitCode: null }],
    [process.execPath, [], { cwd: 'missing folder' }, { status: 'failed', exitCode: null }],
  ]) {
    const shellArgs = type === 'shell' && args.length > 0 ? [join(root, 'lifecycle probe.cjs')] : args;
    if (type === 'shell' && args.length > 0) {
      await writeFile(shellArgs[0], args[1]);
    }
    const task = core.identifyTask(root, core.parseTaskFile(JSON.stringify({ tasks: [
      { label: 'probe', type, command: type === 'shell' && expected.exitCode === null ? process.execPath : command,
        args: type === 'shell' ? shellArgs.map(value => ({ value, quoting: 'strong' })) : args,
        options: type === 'shell' ? { ...options, shell: {
          executable: expected.exitCode === null && !options.cwd ? command : process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
          args: process.platform === 'win32' ? ['/d', '/c'] : ['-c'],
        } } : options },
    ] }), file).tasks[0]);
    const plan = await cliAdapter.resolveCliTaskPlan([task], task);
    const events = [];
    const result = await core.runProcessTask(plan.task, {
      stdin: Readable.from([Buffer.from('standard input')]), onEvent: event => events.push(event),
    });
    assert.equal(result.status, expected.status);
    assert.equal(result.exitCode, expected.exitCode);
    assert.equal(result.signal, null);
    assert.equal(events.at(-1).type, 'complete');
    assert.equal(events.at(-1).result, result);
    assert.equal(events.filter(event => event.type === 'complete').length, 1);
    assert.ok(events.every(event => event.taskIdentity === task.canonicalIdentity));
    const output = stream => Buffer.concat(events.filter(event => event.type === 'output' && event.stream === stream)
      .map(event => event.data)).toString();
    if (expected.exitCode === null) {
      assert.deepEqual(events.map(event => event.type), ['error', 'complete']);
      assert.match(result.error, /tasks\.json:1:.*Cannot start process \(ENOENT\)/u);
      assert.equal(events[0].message, result.error);
    } else {
      assert.equal(events[0].type, 'start');
      assert.ok(events[0].pid > 0);
      assert.equal(output('stdout'), expected.exitCode ? 'last output' : 'standard input');
      assert.equal(output('stderr'), expected.exitCode ? 'failure' : 'stderr');
    }
  }
  }
});

test('process preparation inherits file commands and options with pinned task precedence', async context => {
  const core = await import('@vstask/core');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vstask-globals-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'global folder'));
  const probe = 'process.stdout.write(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),root:process.env.VSTASK_ROOT,task:process.env.VSTASK_TASK}));';
  const file = join(root, '.vscode', 'tasks.json');
  const tasks = core.parseTaskFile(JSON.stringify({ version: '2.0.0', command: process.execPath,
    args: ['-e', probe, 'global'], options: { cwd: 'global folder', env: { VSTASK_ROOT: 'global' } },
    osx: { args: ['-e', probe, 'darwin'] }, windows: { args: ['-e', probe, 'win32'] },
    tasks: [
      { label: 'inherited', args: ['task'], options: { env: { VSTASK_TASK: 'task' } } },
      { label: 'own', type: 'process', command: process.execPath, args: ['-e', probe, 'own'] },
      { label: 'empty cwd', type: 'process', command: process.execPath, args: ['-e', probe, 'own'], options: { cwd: '' } },
    ],
  }), file).tasks.map(task => core.identifyTask(root, task));
  for (const platform of ['darwin', 'win32']) {
    for (const selected of tasks) {
      const plan = await cliAdapter.resolveCliTaskPlan(tasks, selected, { platform });
      const output = [];
      const result = await core.runProcessTask(plan.task, {
        environment: { ...process.env, VSTASK_ROOT: undefined, VSTASK_TASK: undefined }, platform, userHome: root,
        onEvent: event => { if (event.type === 'output' && event.stream === 'stdout') output.push(event.data); },
      });
      assert.equal(result.status, 'success', result.error);
      assert.deepEqual(JSON.parse(Buffer.concat(output).toString()), selected.label === 'inherited'
        ? { argv: [platform, 'task'], cwd: join(root, 'global folder'), task: 'task' }
        : { argv: ['own'], cwd: selected.label === 'empty cwd' ? root : join(root, 'global folder'), root: 'global' });
    }
  }
  assert.equal(tasks[0].configuration.command, undefined);
});

test('CLI returns process status and rejects unresolved or unsupported execution before startup', async context => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vstask-run-status-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.vscode'));
  const file = join(root, '.vscode', 'tasks.json');
  const base = { label: 'probe', type: 'process', command: process.execPath,
    args: ['-e', 'process.stdout.write("task output");process.exitCode=23;'] };
  for (const [changes, extraTasks, options, status, stdout, message] of [
    [{}, [], [], 23, 'task output', /^$/u],
    [{ command: join(root, 'missing executable') }, [], [], 1, '', /Cannot start process \(ENOENT\)/u],
    [{ command: '${input:value}' }, [], ['--input', 'value=private-value'], 1, '', /Cannot start process \(ENOENT\)/u],
    [{ args: ['${input:value}'] }, [], [], 1, '', /no supplied value/u],
    [{ args: [null] }, [], [], 1, '', /command or argument/u],
    [{ options: { env: { INVALID: null } } }, [], [], 1, '', /environment value/u],
    [{ command: '' }, [], [], 1, '', /must not be empty/u],
    [{ type: 'npm' }, [], [], 1, '', /Only process and shell tasks/u],
    [{ isBackground: true }, [], [], 1, '', /Background execution/u],
    [{ dependsOn: 'child' }, [{ ...base, label: 'child' }], [], 1, '', /Dependency execution/u],
    [{ dependsOn: 'missing' }, [], [], 1, '', /Missing dependency/u],
  ]) {
    await writeFile(file, JSON.stringify({ version: '2.0.0', inputs: [
      { id: 'value', type: 'promptString', description: 'Value' },
    ], tasks: [{ ...base, ...changes }, ...extraTasks] }));
    const result = spawnSync(process.execPath, [cli, 'run', 'probe', '--file', file, ...options], {
      encoding: 'utf8', input: '',
    });
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, stdout);
    assert.match(result.stderr, message);
    assert.ok(!result.stderr.includes('private-value'));
  }
});

test('CLI resolves interactive text, password, and choices through Inquirer once per input', async () => {
  const core = await import('@vstask/core');
  const root = fileURLToPath(new URL('../fixtures/', import.meta.url));
  const file = join(root, 'input-probe', '.vscode', 'tasks.json');
  const task = core.identifyTask(root, core.parseTaskFile(JSON.stringify({ inputs: [
    { id: 'name', type: 'promptString', description: 'Name', default: 'initial' },
    { id: 'secret', type: 'promptString', description: 'Secret', password: true },
    { id: 'fallback', type: 'promptString', description: 'Password default', password: true, default: 'fallback-private' },
    { id: 'target', type: 'pickString', description: 'Target',
      options: ['prod', { label: 'Development', value: 'dev' }], default: 'dev' },
  ], tasks: [{ label: 'probe', command: 'probe', args: [
    '${input:name}', '${input:secret}', '${input:fallback}', '${input:target}', '${input:name}', '${env:CHAIN}',
  ] }] }), file).tasks[0]);
  const prompted = [];
  const plan = await cliAdapter.resolveCliTaskPlan([task], task, {
    interactive: true, environment: { CHAIN: '${input:target}' },
    promptInput: async definition => {
      prompted.push(definition.id);
      const { answer, events, getScreen } = await render(cliAdapter.promptCliInput, definition);
      if (definition.id === 'name') {
        assert.match(getScreen(), /initial/u);
      } else if (definition.id === 'secret') {
        events.type('private-value');
        assert.ok(!getScreen().includes('private-value'));
      } else if (definition.id === 'fallback') {
        assert.ok(!getScreen().includes('fallback-private'));
      } else {
        assert.match(getScreen(), /Development: dev/u);
      }
      events.keypress('enter');
      return answer;
    },
  });
  assert.deepEqual(prompted, ['name', 'secret', 'fallback', 'target']);
  assert.deepEqual(plan.task.configuration.args, ['initial', 'private-value', 'fallback-private', 'dev', 'initial', 'dev']);
});

test('CLI prepares supplied inputs and defaults before selected-plan startup', async () => {
  const core = await import('@vstask/core');
  const root = fileURLToPath(new URL('../fixtures/', import.meta.url));
  const file = join(root, 'input-probe', '.vscode', 'tasks.json');
  const tasks = core.parseTaskFile(JSON.stringify({
    inputs: [
      { id: 'name', type: 'promptString', description: 'Name' },
      { id: 'target', type: 'pickString', description: 'Target', options: ['dev', 'prod'], default: 'dev' },
    ],
    tasks: [
      { label: 'probe', command: 'probe', args: ['${input:name}', '${input:target}', '${input:name}'], dependsOn: 'dependency' },
      { label: 'dependency', command: 'probe', args: ['${input:name}'] },
      { label: 'unselected', command: '${input:missing}' },
    ],
  }), file).tasks.map(task => core.identifyTask(root, task));
  let starts = 0;
  const plan = await cliAdapter.resolveCliTaskPlan(tasks, tasks[0], {
    inputs: ['name=earlier', 'name=release=one'], interactive: false,
    promptInput: () => assert.fail('Non-interactive preparation must not prompt.'),
  });
  starts++;
  assert.equal(starts, 1);
  assert.deepEqual(plan.task.configuration.args, ['release=one', 'dev', 'release=one']);
  assert.deepEqual(plan.dependencies[0].task.configuration.args, ['release=one']);
  assert.equal(tasks[0].configuration.args[0], '${input:name}');
  for (const entry of ['private-value', '=private-value']) {
    await assert.rejects(() => cliAdapter.resolveCliTaskPlan(tasks, tasks[0], { inputs: [entry], interactive: false }), error => {
      assert.match(error.message, /id=value/u);
      assert.ok(!error.message.includes('private-value'));
      return true;
    });
  }
});

test('CLI rejects missing, invalid, and canceled inputs before any selected-plan startup', async () => {
  const core = await import('@vstask/core');
  const root = fileURLToPath(new URL('../fixtures/', import.meta.url));
  const file = join(root, 'input-probe', '.vscode', 'tasks.json');
  for (const [definition, options, message] of [
    [{ id: 'required', type: 'promptString', description: 'Required' }, { interactive: false }, /no supplied value/u],
    [{ id: 'required', type: 'promptString', description: 'Required' }, { interactive: true, promptInput: async () => undefined }, /cancel/iu],
    [{ id: 'required', type: 'promptString', description: 'Required' }, { interactive: true, promptInput: async () => { throw new Error('private-value'); } }, /cancel/iu],
    ...['${input:private-value}', '${config:private-value}', '${private-value}'].flatMap(value => [
      [{ id: 'required', type: 'promptString', description: 'Required' }, { interactive: false, inputs: [`required=${value}`] }, /resolved value/u],
      [{ id: 'required', type: 'promptString', description: 'Required', default: value }, { interactive: false }, /resolved value/u],
      [{ id: 'required', type: 'promptString', description: 'Required', password: true }, { interactive: true, promptInput: async () => value }, /resolved value/u],
      [{ id: 'required', type: 'command', command: 'extension.value' }, { interactive: false, resolveInputCommand: async () => value }, /resolved value/u],
    ]),
    [{ id: 'required', type: 'pickString', description: 'Choice', options: ['dev'], default: 'private-value' }, { interactive: false }, /configured input choice/u],
    [{ id: 'required', type: 'pickString', description: 'Choice', options: ['dev'] }, { interactive: false, inputs: ['required=private-value'] }, /configured input choice/u],
    [{ id: 'required', type: 'pickString', description: 'Choice', options: [null] }, { interactive: false }, /definition/u],
    [{ id: 'required', type: 'promptString' }, { interactive: false }, /definition/u],
    [undefined, { interactive: false, inputs: ['required=private-value'] }, /defined/u],
  ]) {
    const tasks = core.parseTaskFile(JSON.stringify({ inputs: definition ? [definition] : [], tasks: [
      { label: 'probe', command: 'probe', dependsOn: ['ready', 'needs-input'] },
      { label: 'ready', command: 'probe' },
      { label: 'needs-input', command: 'probe', args: ['${input:required}'] },
    ] }), file).tasks.map(task => core.identifyTask(root, task));
    let starts = 0;
    await assert.rejects(async () => {
      await cliAdapter.resolveCliTaskPlan(tasks, tasks[0], options);
      starts++;
    }, error => {
      const source = tasks[2].source;
      assert.ok(error.message.startsWith(`${file}:${source.line}:${source.column}:`));
      assert.match(error.message, message);
      assert.ok(!error.message.includes('private-value'));
      return true;
    });
    assert.equal(starts, 0);
  }
});

test('CLI and VS Code prepare file-scoped inputs and retain shared plan nodes', async () => {
  const core = await import('@vstask/core');
  const root = fileURLToPath(new URL('../fixtures/', import.meta.url));
  const parse = (folder, inputs, tasks) => core.parseTaskFile(JSON.stringify({ inputs, tasks }),
    join(root, folder, '.vscode', 'tasks.json')).tasks.map(task => core.identifyTask(root, task));
  const source = parse('app', [{ id: 'value', type: 'promptString', description: 'App', default: 'app' }], [
    { label: 'probe', command: 'probe', args: ['${input:value}'], dependsOn: ['ws:tools', 'ws:shared'] },
    { label: 'unused', command: '${input:missing}' },
  ]);
  const tools = parse('tools', [
    { id: 'value', type: 'promptString', description: 'Old', default: 'old' },
    { id: 'value', type: 'promptString', description: 'Tools', default: 'last' },
  ], [{ label: 'tools', command: 'probe', args: ['${input:value}'], dependsOn: 'ws:shared' }]);
  const shared = parse('shared', [{ id: 'value', type: 'promptString', description: 'Shared', default: '' }], [
    { label: 'shared', command: 'probe', args: ['${input:value}'] },
  ]);
  const tasks = [...source, ...tools, ...shared];
  for (const prepare of [cliAdapter.resolveCliTaskPlan, resolveVSCodeTaskPlan]) {
    const plan = await prepare(tasks, source[0], {
      interactive: false,
      ...(prepare === cliAdapter.resolveCliTaskPlan ? { inputs: ['tools/.vscode/tasks.json#value=override=one'] }
        : { inputValues: { 'tools/.vscode/tasks.json#value': 'override=one' } }),
    });
    assert.deepEqual(plan.task.configuration.args, ['app']);
    assert.deepEqual(plan.dependencies[0].task.configuration.args, ['override=one']);
    assert.deepEqual(plan.dependencies[1].task.configuration.args, ['']);
    assert.equal(plan.dependencies[0].dependencies[0], plan.dependencies[1]);
    const defaults = await prepare(tasks, source[0], { interactive: false });
    assert.deepEqual(defaults.dependencies[0].task.configuration.args, ['last']);
  }
});

test('input preparation uses supplied command values or an explicit command resolver before startup', async () => {
  const core = await import('@vstask/core');
  const root = fileURLToPath(new URL('../fixtures/', import.meta.url));
  const file = join(root, 'input-probe', '.vscode', 'tasks.json');
  const task = core.identifyTask(root, core.parseTaskFile(JSON.stringify({ inputs: [
    { id: 'tool', type: 'command', command: 'extension.tool', args: { target: '${workspaceFolder}' } },
  ], tasks: [{ label: 'probe', command: 'probe', args: ['${input:tool}', '${input:tool}'] }] }), file).tasks[0]);
  for (const prepare of [cliAdapter.resolveCliTaskPlan, resolveVSCodeTaskPlan]) {
    let calls = 0;
    const plan = await prepare([task], task, { interactive: false,
      resolveInputCommand: async (command, args, source) => {
        calls++;
        assert.equal(command, 'extension.tool');
        assert.deepEqual({ ...args }, { target: '${workspaceFolder}' });
        assert.equal(source.canonicalIdentity, task.canonicalIdentity);
        return 'value';
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(plan.task.configuration.args, ['value', 'value']);
    const supplied = await prepare([task], task, { interactive: false, inputValues: { tool: '' },
      resolveInputCommand: async () => assert.fail('Supplied command inputs must not call a provider.'),
    });
    assert.deepEqual(supplied.task.configuration.args, ['', '']);
    for (const resolver of [undefined, async () => undefined, async () => 42, async () => { throw new Error('private-value'); }]) {
      let starts = 0;
      await assert.rejects(async () => {
        await prepare([task], task, { interactive: false, resolveInputCommand: resolver });
        starts++;
      }, error => {
        assert.ok(error.message.startsWith(`${file}:${task.source.line}:${task.source.column}:`));
        assert.match(error.message, /command.*(available|failed|string)/iu);
        assert.ok(!error.message.includes('private-value'));
        return true;
      });
      assert.equal(starts, 0);
    }
  }
});

test('CLI resolves supplied editor context from options and a context file without an editor host', async context => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vstask-editor-context-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, '.vscode', 'tasks.json');
  const activeFile = join(root, 'src', 'two words.test.ts');
  await mkdir(join(root, '.vscode'));
  const variables = ['file', 'fileWorkspaceFolder', 'fileWorkspaceFolderBasename', 'relativeFile', 'relativeFileDirname',
    'fileDirname', 'fileExtname', 'fileBasename', 'fileBasenameNoExtension', 'fileDirnameBasename',
    'selectedText', 'lineNumber', 'columnNumber'];
  await writeFile(file, JSON.stringify({ tasks: [{ label: 'editor probe', type: 'process', command: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)));', ...variables.map(name => '${' + name + '}')],
  }, { label: 'unused', command: '${input:missing}' }] }));
  const supplied = { file: activeFile, fileWorkspaceFolder: root, selectedText: 'two words=one\nnext', lineNumber: 3, columnNumber: 5 };
  const contextFile = join(root, 'context.json');
  await writeFile(contextFile, JSON.stringify({ ...supplied, selectedText: 'file value' }));
  const expected = [activeFile, root, root.split(/[\\/]/u).at(-1), join('src', 'two words.test.ts'), 'src',
    join(root, 'src'), '.ts', 'two words.test.ts', 'two words.test', 'src', supplied.selectedText, '3', '5'];
  for (const options of [
    Object.entries(supplied).flatMap(([name, value]) => ['--context', `${name}=${value}`]),
    ['--context-file', contextFile, '--context', `selectedText=${supplied.selectedText}`],
  ]) {
    const result = spawnSync(process.execPath, [cli, 'run', 'editor probe', '--file', file, ...options], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
    assert.equal(result.stderr, '');
  }
});

test('CLI editor-context preflight stops the selected plan and ignores unrelated context requirements', async context => {
  const core = await import('@vstask/core');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vstask-editor-preflight-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, '.vscode', 'tasks.json');
  const marker = join(root, 'started');
  await mkdir(join(root, '.vscode'));
  const args = ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`];
  for (const [variable, editorContext, message] of [
    ['file', {}, /--context file=value/u],
    ['fileWorkspaceFolder', { file: join(root, 'outside.ts') }, /--context fileWorkspaceFolder=value/u],
    ['selectedText', {}, /--context selectedText=value/u],
    ['selectedText', { selectedText: '' }, /--context selectedText=value/u],
    ['lineNumber', { lineNumber: 0 }, /--context lineNumber=value/u],
    ['columnNumber', { columnNumber: 1.5 }, /--context columnNumber=value/u],
    ['lineNumber', { lineNumber: '3' }, /--context lineNumber=value/u],
    ['selectedText', { selectedText: '${config:private-value}' }, /resolved value/u],
    ['file', { file: join(root, '${config:private-value}') }, /resolved value/u],
    ['fileWorkspaceFolder', { fileWorkspaceFolder: join(root, '${config:private-value}') }, /resolved value/u],
  ]) {
    const definitions = { tasks: [
      { label: 'plan', type: 'process', command: process.execPath, args, dependsOn: ['ready', 'required'] },
      { label: 'ready', type: 'process', command: process.execPath, args },
      { label: 'required', type: 'process', command: process.execPath, args: [...args, '${' + variable + '}'] },
    ] };
    await writeFile(file, JSON.stringify(definitions));
    const tasks = core.parseTaskFile(JSON.stringify(definitions), file).tasks.map(task => core.identifyTask(root, task));
    const contextFile = join(root, 'context.json');
    await writeFile(contextFile, JSON.stringify(editorContext));
    const failure = spawnSync(process.execPath, [cli, 'run', 'plan', '--file', file, '--context-file', contextFile], { encoding: 'utf8' });
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, '');
    assert.ok(failure.stderr.startsWith(`${file}:${tasks[2].source.line}:${tasks[2].source.column}:`));
    assert.match(failure.stderr, message);
    assert.ok(!failure.stderr.includes('private-value'));
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  }
  const result = spawnSync(process.execPath, [cli, 'run', 'ready', '--file', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(marker, 'utf8'), 'started');
});

test('CLI and VS Code variable probes agree with the pinned upstream evaluator', async context => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vstask-baseline-variables-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = await createTaskFile(root, '', '${env:VSTASK_TOOL}');
  const configuration = {
    label: '${env:VSTASK_TOOL}', command: '${config:probe.tool}',
    args: ['${workspaceFolder}', '${workspaceRoot}', '${cwd}', '${workspaceFolderBasename}', '${workspaceRootFolderName}',
      '${userHome}', '${pathSeparator}', '${/}', '${env:VSTASK_UNSET}', '${config:probe.boolean}', '${config:probe.number}',
      '${config:probe.array}', '${env:VSTASK_CHAIN}'],
    options: { cwd: '${config:probe.cwd}', env: { VSTASK_TOOL: 'task', '${config:probe.key}': '${env:VSTASK_TOOL}' },
      shell: { executable: '${env:VSTASK_TOOL}', args: ['${config:probe.value}'] } },
  };
  await writeFile(file, JSON.stringify({ tasks: [configuration] }));
  const settings = {
    'probe.tool': '${env:VSTASK_TOOL}', 'probe.boolean': false, 'probe.number': 0, 'probe.array': ['one', 'two'],
    'probe.cwd': 'output', 'probe.key': 'OUT', 'probe.value': '${workspaceFolderBasename}',
  };
  const environment = { ...process.env, VSTASK_TOOL: 'probe', VSTASK_CHAIN: '${config:probe.value}' };
  delete environment.VSTASK_UNSET;
  const baseline = baselineResolver(root, settings, environment);
  const expected = await baseline.resolveAsync({ uri: { fsPath: root } }, {
    command: configuration.command, args: configuration.args, options: configuration.options,
  });
  expected.options.cwd = join(root, expected.options.cwd);
  const core = await import('@vstask/core');
  const task = core.identifyTask(root, core.parseTaskFile(JSON.stringify({ tasks: [configuration] }), file).tasks[0]);
  const extension = await resolveVSCodeTaskPlan([task], task, { configuration: settings, environment });
  const cliPlan = await cliAdapter.resolveCliTaskPlan([task], task, { configuration: settings, environment });
  for (const plan of [extension, cliPlan]) {
    const { command, args, options, label } = plan.task.configuration;
    assert.deepEqual({ command, args, options }, expected);
    assert.equal(label, configuration.label);
    assert.equal(plan.task.canonicalIdentity, task.canonicalIdentity);
  }
});

test('CLI and VS Code prepare selected variable probes without resolving unrelated tasks', async context => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vstask-variables-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = await createTaskFile(root, '', 'probe');
  const configuration = { version: '2.0.0', tasks: [
    { label: 'probe', command: '${env:VSTASK_PROBE_TOOL}', dependsOn: 'dependency',
      args: ['${config:probe.value}', '${workspaceFolderBasename}'] },
    { label: 'dependency', command: 'probe', options: { cwd: '${config:probe.cwd}' } },
    { label: 'unselected', command: '${config:missing}' },
  ] };
  await writeFile(file, JSON.stringify(configuration));
  const settings = { 'probe.value': false, 'probe.cwd': 'output' };
  const core = await import('@vstask/core');
  const tasks = core.parseTaskFile(JSON.stringify(configuration), file).tasks.map(task => core.identifyTask(root, task));
  const extensionPlan = await resolveVSCodeTaskPlan(tasks, tasks[0], {
    environment: { VSTASK_PROBE_TOOL: 'probe' }, configuration: settings,
  });
  const cliPlan = await cliAdapter.resolveCliTaskPlan(tasks, tasks[0], {
    environment: { VSTASK_PROBE_TOOL: 'probe' }, configuration: settings,
  });
  assert.deepEqual(cliPlan, extensionPlan);
  assert.equal(cliPlan.task.configuration.command, 'probe');
  assert.deepEqual(cliPlan.task.configuration.args, ['false', root.split(/[\\/]/u).at(-1)]);
  assert.equal(cliPlan.dependencies[0].task.configuration.options.cwd, join(root, 'output'));
  delete settings['probe.cwd'];
  await assert.rejects(() => resolveVSCodeTaskPlan(tasks, tasks[0], { configuration: settings }), /resolve variable.*config:probe.cwd/u);
  await assert.rejects(() => cliAdapter.resolveCliTaskPlan(tasks, tasks[0], { configuration: settings }), /resolve variable.*config:probe.cwd/u);
});

test('CLI help describes commands and options without reading task files', async context => {
  const root = await mkdtemp(join(tmpdir(), 'vstask-help-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = await createTaskFile(root, '', 'build');
  await writeFile(file, '{');
  const help = spawnSync(process.execPath, [cli, '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, '');
  assert.match(help.stdout, /vstask list/u);
  assert.match(help.stdout, /vstask select/u);
  for (const command of ['list', 'select']) {
    const result = spawnSync(process.execPath, [cli, command, '--help'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    for (const option of ['--workspace', '--exclude', '--file', '--no-default-excludes']) {
      assert.ok(result.stdout.includes(option), option);
    }
  }
});

test('CLI rejects invalid arguments and conflicting discovery options without task output', () => {
  const fixture = fileURLToPath(new URL('../fixtures/listing/.vscode/tasks.json', import.meta.url));
  for (const args of [
    ['list', '--unknown'],
    ['list', 'unexpected'],
    ['list', '--workspace'],
    ['select'],
    ['select', 'build', '--exclude'],
    ['list', '--file', fixture, '--workspace', '.'],
    ['select', 'fixture:build', '--file', fixture, '--exclude', 'cache'],
    ['list', '--file', fixture, '--no-default-excludes'],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.notEqual(result.stderr, '', args.join(' '));
  }
});

test('CLI lists a commented task with its source location', () => {
  for (const [name, label, line] of [
    ['listing', 'fixture:build', 6],
    ['duplicate-properties', 'fixture:current', 7],
  ]) {
    const fixture = fileURLToPath(new URL(`../fixtures/${name}/.vscode/tasks.json`, import.meta.url));
    const result = spawnSync(process.execPath, [cli, 'list', '--file', fixture], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const [listedLabel, location] = result.stdout.trim().split('\t');
    assert.equal(listedLabel, label);
    assert.equal(location, `${fixture}:${line}:4`);
  }
});

async function createTaskFile(root, folder, label) {
  const directory = join(root, folder, '.vscode');
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'tasks.json');
  await writeFile(file, JSON.stringify({ version: '2.0.0', tasks: [{ label, type: 'process', command: 'unused' }] }));
  return file;
}

test('CLI fuzzy selection finds partial names and typing errors without execution', async context => {
  const root = await mkdtemp(join(tmpdir(), 'vstask-fuzzy-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = await createTaskFile(root, 'workflow', 'start-aspire');
  const marker = join(root, 'started');
  await writeFile(file, JSON.stringify({ version: '2.0.0', tasks: [{ label: 'start-aspire', type: 'process',
    command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`] }] }));
  await createTaskFile(root, 'other', 'build-client');
  for (const query of ['aspire', 'aspre']) {
    const result = spawnSync(process.execPath, [cli, 'select', query, '--fuzzy', '--workspace', root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const rows = result.stdout.trim().split('\n').map(row => row.split('\t'));
    assert.deepEqual(rows.map(([label]) => label), ['start-aspire']);
    assert.match(rows[0][2], /^vstask:/u);
  }
  const longLabel = 'a-task-name-with-a-long-prefix-that-puts-the-query-beyond-the-default-location-window-aspire';
  await createTaskFile(root, 'long', longLabel);
  const multiple = spawnSync(process.execPath, [cli, 'select', 'aspire', '--fuzzy', '--workspace', root,
    '--workspace', root], { encoding: 'utf8' });
  assert.equal(multiple.status, 0, multiple.stderr);
  const rows = multiple.stdout.trim().split('\n').map(row => row.split('\t'));
  assert.deepEqual(rows.map(([label]) => label).sort(), [longLabel, 'start-aspire'].sort());
  assert.equal(new Set(rows.map(([, , identity]) => identity)).size, 2);
  const exact = spawnSync(process.execPath, [cli, 'select', 'start-aspire', '--fuzzy', '--workspace', root], { encoding: 'utf8' });
  assert.equal(exact.status, 0, exact.stderr);
  assert.equal(exact.stdout.trim().split('\n').length, 1);
  assert.equal(exact.stdout.split('\t')[0], 'start-aspire');
  for (const query of ['zzzzzzzzzzzz', '   ']) {
    const result = spawnSync(process.execPath, [cli, 'select', query, '--fuzzy', '--workspace', root], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /No task matches fuzzy query/u);
  }
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('CLI run starts one canonical fuzzy match only with explicit non-interactive permission', async context => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vstask-run-selection-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = await createTaskFile(root, 'workflow', 'start-aspire');
  const marker = join(root, 'started');
  await writeFile(file, JSON.stringify({ version: '2.0.0', tasks: [{ label: 'start-aspire', type: 'process',
    command: process.execPath, args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'started\\n');process.exitCode=23;`] }] }));
  const denied = spawnSync(process.execPath, [cli, 'run', 'aspire', '--workspace', root], { encoding: 'utf8', input: '' });
  assert.equal(denied.status, 1);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  const allowed = spawnSync(process.execPath, [cli, 'run', 'aspre', '--fuzzy', '--threshold=0.3', '--workspace', root], { encoding: 'utf8', input: '' });
  assert.equal(allowed.status, 23, allowed.stderr);
  assert.equal(await readFile(marker, 'utf8'), 'started\n');
  await rm(marker);
  for (const options of [['--fuzzy', '--threshold=0'], ['--fuzzy', '--threshold=-1'], ['--threshold=0.3']]) {
    const rejected = spawnSync(process.execPath, [cli, 'run', 'aspre', ...options, '--workspace', root], { encoding: 'utf8', input: '' });
    assert.equal(rejected.status, 1);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  }
  const other = await createTaskFile(root, 'other', 'start-aspire');
  await writeFile(other, JSON.stringify({ version: '2.0.0', tasks: [{ label: 'start-aspire', type: 'process',
    command: process.execPath, args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'other\\n');`] }] }));
  const listing = spawnSync(process.execPath, [cli, 'list', '--workspace', root], { encoding: 'utf8' });
  const identities = listing.stdout.trim().split('\n').map(row => row.split('\t')[2]);
  for (const [query, options] of [['aspire', ['--fuzzy']], ['start-aspire', []], ['start-aspire', ['--fuzzy']], ['zzzzzzzzzzzz', ['--fuzzy']]]) {
    const result = spawnSync(process.execPath, [cli, 'run', query, ...options, '--workspace', root], { encoding: 'utf8', input: '', timeout: 3000 });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    if (query !== 'zzzzzzzzzzzz') {
      for (const identity of identities) assert.ok(result.stderr.includes(identity), result.stderr);
    }
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  }
  const exact = spawnSync(process.execPath, [cli, 'run', identities.find(identity => identity.includes('workflow')), '--fuzzy', '--workspace', root], { encoding: 'utf8', input: '' });
  assert.equal(exact.status, 23, exact.stderr);
  assert.equal(await readFile(marker, 'utf8'), 'started\n');
});

test('interactive CLI run displays one match and requires a canonical menu choice for ambiguity', async context => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vstask-interactive-selection-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = await createTaskFile(root, 'workflow', 'start-aspire');
  const marker = join(root, 'started');
  await writeFile(file, JSON.stringify({ version: '2.0.0', tasks: [{ label: 'start-aspire', type: 'process',
    command: process.execPath, args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'start-aspire\\n');`] }] }));
  const runInteractive = args => render(async (_config, terminal) => {
    const stdin = new PassThrough();
    context.after(() => stdin.destroy());
    stdin.isTTY = true;
    terminal.input.on('data', chunk => stdin.write(chunk));
    terminal.input.on('keypress', (...args) => stdin.emit('keypress', ...args));
    terminal.output.isTTY = true;
    return cliAdapter.runCli(args, {
      stdin, stdout: terminal.output, stderr: terminal.output,
    });
  }, {});
  const { answer, getScreen } = await runInteractive(['run', 'aspire', '--workspace', root]);
  assert.equal(await answer, 0);
  assert.match(getScreen(), /start-aspire/u);
  assert.match(getScreen(), /vstask:/u);
  assert.equal(await readFile(marker, 'utf8'), 'start-aspire\n');
  await rm(marker);
  const other = await createTaskFile(root, 'other', 'stop-aspire');
  await writeFile(other, JSON.stringify({ version: '2.0.0', tasks: [{ label: 'stop-aspire', type: 'process',
    command: process.execPath, args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'stop-aspire\\n');`] }] }));
  const menu = await runInteractive(['run', 'aspire', '--workspace', root]);
  await waitFor(() => assert.match(menu.getScreen(), /Select a task/u));
  const displayed = menu.getScreen().split('\n').filter(line => line.includes('vstask:'));
  assert.equal(displayed.length, 2);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  menu.events.keypress('down');
  menu.events.keypress('enter');
  assert.equal(await menu.answer, 0);
  const chosenLabel = displayed[1].includes('stop-aspire') ? 'stop-aspire' : 'start-aspire';
  assert.equal(await readFile(marker, 'utf8'), `${chosenLabel}\n`);
  await rm(marker);
  await writeFile(other, JSON.stringify({ version: '2.0.0', tasks: [{ label: 'start-aspire', type: 'process',
    command: process.execPath, args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'other\\n');`] }] }));
  const duplicate = await runInteractive(['run', 'start-aspire', '--workspace', root]);
  await waitFor(() => assert.match(duplicate.getScreen(), /Select a task/u));
  const duplicateChoices = duplicate.getScreen().split('\n').filter(line => line.includes('vstask:'));
  assert.equal(duplicateChoices.length, 2);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  duplicate.events.keypress('down');
  duplicate.events.keypress('enter');
  assert.equal(await duplicate.answer, 0);
  const chosenSource = duplicateChoices[1].includes('other%2F') ? 'other' : 'start-aspire';
  assert.equal(await readFile(marker, 'utf8'), `${chosenSource}\n`);
  await rm(marker);
  const cancelled = await runInteractive(['run', 'aspire', '--workspace', root]);
  await waitFor(() => assert.match(cancelled.getScreen(), /Select a task/u));
  cancelled.input.emit('keypress', null, { name: 'c', ctrl: true });
  assert.equal(await cancelled.answer, 1);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('CLI ranking preserves exact priority and returns distinct candidates in score order', async () => {
  const root = fileURLToPath(new URL('../fixtures', import.meta.url));
  const { identifyTask, parseTaskFile } = await import('@vstask/core');
  const tasks = ['start-aspre', 'start-aspire', 'start-aspiree'].map((label, index) => identifyTask(root,
    parseTaskFile(JSON.stringify({ version: '2.0.0', tasks: [{ label, type: 'process', command: 'unused' }] }),
      join(root, `project-${index}`, '.vscode', 'tasks.json')).tasks[0]));
  const repeated = [...tasks, tasks[1], tasks[0]];
  const ranked = cliAdapter.rankCliTasks(repeated, 'aspire');
  assert.equal(ranked.length, 3);
  assert.equal(new Set(ranked.map(candidate => candidate.task.canonicalIdentity)).size, 3);
  assert.equal(ranked[0].task, tasks[1]);
  assert.ok(ranked.every((candidate, index) => Number.isFinite(candidate.score)
    && (index === 0 || candidate.score >= ranked[index - 1].score)));
  const qualified = cliAdapter.rankCliTasks(repeated, 'project-2');
  assert.equal(qualified[0].task, tasks[2]);
  for (const selector of [tasks[1].label, tasks[1].qualifiedSelector, tasks[1].canonicalIdentity]) {
    assert.deepEqual(cliAdapter.rankCliTasks(repeated, selector), [{ task: tasks[1], score: 0 }]);
  }
  const shadow = { ...tasks[0], label: tasks[1].canonicalIdentity };
  assert.equal(cliAdapter.rankCliTasks([shadow, ...tasks], tasks[1].canonicalIdentity)[0].task, tasks[1]);
  const duplicate = { ...tasks[0], label: tasks[1].label };
  assert.throws(() => cliAdapter.rankCliTasks([duplicate, ...tasks], tasks[1].label), /Ambiguous exact selector/u);
  for (const query of ['zzzzzzzzzzzz', '', '   ']) {
    assert.deepEqual(cliAdapter.rankCliTasks(repeated, query), []);
  }
});

test('CLI fuzzy threshold controls candidates and rejects invalid configuration', async context => {
  const root = await mkdtemp(join(tmpdir(), 'vstask-threshold-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createTaskFile(root, '', 'start-aspire');
  for (const [query, threshold, success] of [
    ['aspre', '0.3', true], ['aspre', '0', false], ['aspire', '0', true],
    ['start-aspire', '0', true], ['aspre', '-1', false], ['aspre', '1.1', false],
    ['start-aspire', 'NaN', false], ['aspre', 'Infinity', false], ['aspre', '', false],
  ]) {
    const result = spawnSync(process.execPath, [cli, 'select', query, '--fuzzy', `--threshold=${threshold}`,
      '--workspace', root], { encoding: 'utf8' });
    assert.equal(result.status, success ? 0 : 1, `${query}/${threshold}: ${result.stderr}`);
    if (success) {
      assert.equal(result.stdout.split('\t')[0], 'start-aspire');
      assert.equal(result.stderr, '');
    } else {
      assert.equal(result.stdout, '');
      assert.match(result.stderr, threshold === '0' ? /No task matches/u : /threshold.*0.*1/u);
    }
  }
  const exact = spawnSync(process.execPath, [cli, 'select', 'start-aspire', '--threshold=0.3',
    '--workspace', root], { encoding: 'utf8' });
  assert.equal(exact.status, 1);
  assert.equal(exact.stdout, '');
  assert.match(exact.stderr, /--threshold requires --fuzzy/u);
});

test('CLI selects canonical identities across duplicate files and discovery roots', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'vstask-select-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const firstRoot = join(directory, 'first');
  const secondRoot = join(directory, 'second');
  const nestedRoot = join(firstRoot, 'nested');
  await createTaskFile(firstRoot, '', 'build');
  await createTaskFile(nestedRoot, '', 'build');
  await createTaskFile(secondRoot, '', 'build');
  const options = [firstRoot, secondRoot, nestedRoot].flatMap(root => ['--workspace', root]);
  const listing = spawnSync(process.execPath, [cli, 'list', ...options], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  const rows = listing.stdout.trim().split('\n').map(row => row.split('\t'));
  const identities = rows.map(([, , identity]) => identity);
  assert.equal(identities.length, 4);
  assert.ok(identities.every(identity => typeof identity === 'string' && identity.startsWith('vstask:')));
  assert.equal(new Set(identities).size, 4);
  for (const row of rows) {
    const selected = spawnSync(process.execPath, [cli, 'select', row[2], ...options], { encoding: 'utf8' });
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(selected.stderr, '');
    assert.equal(selected.stdout, `${row.join('\t')}\n`);
  }
  await createTaskFile(firstRoot, 'shadow', identities[0]);
  const canonical = spawnSync(process.execPath, [cli, 'select', identities[0], ...options], { encoding: 'utf8' });
  assert.equal(canonical.status, 0, canonical.stderr);
  assert.equal(canonical.stdout, `${rows[0].join('\t')}\n`);
});

test('CLI resolves unique exact selectors and rejects ambiguous or missing selectors', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'vstask-exact-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const firstRoot = join(directory, 'first');
  const secondRoot = join(directory, 'second');
  await createTaskFile(firstRoot, '', 'build');
  await createTaskFile(firstRoot, 'apps/client', 'build');
  await createTaskFile(firstRoot, 'apps/release', 'release:#%');
  await createTaskFile(firstRoot, 'apps/options', '--release');
  await createTaskFile(secondRoot, '', 'build');
  const options = [firstRoot, secondRoot].flatMap(root => ['--workspace', root]);
  const listing = spawnSync(process.execPath, [cli, 'list', ...options], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  const rows = listing.stdout.trim().split('\n').map(row => row.split('\t'));
  for (const [selector, expected] of [
    ['release:#%', rows.find(([label]) => label === 'release:#%')],
    ['apps/client/.vscode/tasks.json#build', rows.find(([, , , qualified]) => qualified === 'apps/client/.vscode/tasks.json#build')],
    ['apps/release/.vscode/tasks.json#release%3A%23%25', rows.find(([label]) => label === 'release:#%')],
    ['--release', rows.find(([label]) => label === '--release')],
  ]) {
    const selected = spawnSync(process.execPath, [cli, 'select', ...options, '--', selector], { encoding: 'utf8' });
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(selected.stderr, '');
    assert.equal(selected.stdout, `${expected.join('\t')}\n`);
  }
  const repeated = spawnSync(process.execPath, [cli, 'select', 'release:#%', ...options, '--workspace', firstRoot], { encoding: 'utf8' });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.stdout, `${rows.find(([label]) => label === 'release:#%').join('\t')}\n`);
  for (const [selector, candidates] of [
    ['build', rows.filter(([label]) => label === 'build')],
    ['.vscode/tasks.json#build', rows.filter(([, , , qualified]) => qualified === '.vscode/tasks.json#build')],
    ['buil', []],
  ]) {
    const selected = spawnSync(process.execPath, [cli, 'select', selector, ...options], { encoding: 'utf8' });
    assert.equal(selected.status, 1);
    assert.equal(selected.stdout, '');
    assert.match(selected.stderr, candidates.length ? /Ambiguous exact selector/u : /No task matches exact selector/u);
    for (const [, , identity] of candidates) {
      assert.ok(selected.stderr.includes(identity));
      const qualified = spawnSync(process.execPath, [cli, 'select', identity, ...options], { encoding: 'utf8' });
      assert.equal(qualified.status, 0, qualified.stderr);
    }
  }
});

test('CLI lists root and nested task files from a discovery root', async context => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vstask-discovery-')));
  const outside = await mkdtemp(join(tmpdir(), 'vstask-outside-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(outside, { recursive: true, force: true }));
  const files = [
    await createTaskFile(root, '', 'root:build'),
    await createTaskFile(root, 'apps/client', 'client:build'),
    await createTaskFile(root, 'apps/server', 'server:build'),
    await createTaskFile(root, 'ignored-by-git', 'ignored:build'),
  ];
  await writeFile(join(root, '.gitignore'), 'ignored-by-git/\n');
  await writeFile(join(root, 'tasks.json'), JSON.stringify({ tasks: [{ label: 'not-a-task-file' }] }));
  await mkdir(join(root, 'other.vscode'));
  await writeFile(join(root, 'other.vscode/tasks.json'), JSON.stringify({ tasks: [{ label: 'wrong-folder' }] }));
  await createTaskFile(outside, '', 'outside:build');
  await symlink(outside, join(root, 'linked-project'), 'junction');
  await symlink(root, join(root, 'loop'), 'junction');

  for (const options of [
    [],
    ['--workspace', root],
    ['--workspace', root, '--workspace', join(root, 'linked-project'), '--workspace', join(root, 'loop')],
  ]) {
    const result = spawnSync(process.execPath, [cli, 'list', ...options], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const rows = result.stdout.trim().split('\n').map(row => row.split('\t'));
    assert.deepEqual(rows.map(([label]) => label), ['root:build', 'client:build', 'server:build', 'ignored:build']);
    assert.deepEqual(rows.map(([, location]) => location.replace(/:\d+:\d+$/u, '')), files);
  }
});

test('CLI applies configured discovery exclusions and default overrides', async context => {
  const root = await mkdtemp(join(tmpdir(), 'vstask-exclusions-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [folder, label] of [
    ['', 'root'],
    ['.git', 'git'],
    ['node_modules/dependency', 'dependency'],
    ['apps/client/node_modules/dependency', 'nested-dependency'],
    ['cache', 'cache'],
    ['apps/client/cache', 'nested-cache'],
    ['apps/server', 'server'],
  ]) {
    await createTaskFile(root, folder, label);
  }
  for (const [options, expected] of [
    [[], ['cache', 'nested-cache', 'root', 'server']],
    [['--exclude', 'cache'], ['root', 'server']],
    [['--exclude', 'apps/client/cache'], ['cache', 'root', 'server']],
    [['--exclude', 'cache', '--exclude', 'apps/server'], ['root']],
    [['--no-default-excludes'], ['cache', 'dependency', 'git', 'nested-cache', 'nested-dependency', 'root', 'server']],
    [['--no-default-excludes', '--exclude', 'cache'], ['dependency', 'git', 'nested-dependency', 'root', 'server']],
  ]) {
    const result = spawnSync(process.execPath, [cli, 'list', '--workspace', root, ...options], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(result.stdout.trim().split('\n').map(row => row.split('\t')[0]).sort(), expected, options.join(' '));
  }
});

test('core and CLI keep separate and overlapping discovery-root scopes', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'vstask-roots-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const firstRoot = join(directory, 'first');
  const secondRoot = join(directory, 'second');
  const nestedRoot = join(firstRoot, 'nested');
  const firstFile = await createTaskFile(firstRoot, '', 'build');
  const nestedFile = await createTaskFile(nestedRoot, '', 'build');
  const secondFile = await createTaskFile(secondRoot, '', 'build');
  const roots = [firstRoot, secondRoot, nestedRoot];
  const expected = [
    { discoveryRoot: firstRoot, file: firstFile },
    { discoveryRoot: firstRoot, file: nestedFile },
    { discoveryRoot: secondRoot, file: secondFile },
    { discoveryRoot: nestedRoot, file: nestedFile },
  ];

  assert.deepEqual(await discoverTaskFiles(roots), expected);
  const result = spawnSync(process.execPath, [cli, 'list', ...roots.flatMap(root => ['--workspace', root])], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const rows = result.stdout.trim().split('\n').map(row => row.split('\t'));
  assert.deepEqual(rows.map(([label]) => label), ['build', 'build', 'build', 'build']);
  assert.deepEqual(rows.map(([, location]) => location.replace(/:\d+:\d+$/u, '')), expected.map(({ file }) => file));
});