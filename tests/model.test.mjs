import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import * as core from '@vstask/core';
import { baselineResolver } from './upstream-variable-resolver.mjs';

const { parseTaskFile } = core;

test('core normalizes task groups while preserving the source configuration', () => {
  for (const [properties, expected] of [
    ...['build', 'test', 'clean', 'rebuild'].map(kind => [{ group: kind }, { kind, isDefault: false }]),
    [{ group: { kind: 'build', isDefault: true } }, { kind: 'build', isDefault: true }],
    [{ group: { kind: 'test' } }, { kind: 'test', isDefault: false }],
    [{ group: { kind: 'build', isDefault: '*.ts' } }, { kind: 'build', isDefault: '*.ts' }],
    [{ group: 'none' }, undefined], [{ group: { kind: 'unknown' } }, undefined],
    [{ isBuildCommand: true }, { kind: 'build', isDefault: false }],
    [{ isTestCommand: true }, { kind: 'test', isDefault: false }],
    [{ group: 'test', isBuildCommand: true }, { kind: 'test', isDefault: false }],
  ]) {
    const configuration = { label: 'probe', type: 'process', command: 'probe', ...properties };
    const task = parseTaskFile(JSON.stringify({ tasks: [configuration] }), 'groups/.vscode/tasks.json').tasks[0];
    assert.deepEqual(task.group, expected, JSON.stringify(properties));
    const identified = core.identifyTask(resolve('groups'), task);
    assert.deepEqual(core.resolveTaskVariables(identified).group, expected);
    assert.equal(JSON.stringify(task.configuration), JSON.stringify(configuration), 'Normalization does not change the source configuration.');
  }
});

test('core preserves pinned build and test label inference within each task file', () => {
  const build = { kind: 'build', isDefault: false };
  const testGroup = { kind: 'test', isDefault: false };
  for (const [definitions, expected] of [
    [[{ label: 'build' }], [build]],
    [[{ label: 'test' }], [testGroup]],
    [[{ label: 'build' }, { label: 'test' }], [build, undefined]],
    [[{ label: 'build', group: 'test' }], [build]],
    [[{ label: 'build' }, { label: 'legacy', isBuildCommand: true }], [undefined, build]],
    [[{ label: 'test' }, { label: 'legacy', isTestCommand: true }], [undefined, testGroup]],
    [[{ label: 'build', group: 'build' }, { label: 'test' }], [build, testGroup]],
    [[{ label: 'build', type: 'unavailable' }], [undefined]],
  ]) {
    const tasks = parseTaskFile(JSON.stringify({ version: '2.0.0', tasks: definitions.map(task => ({
      type: 'process', command: 'probe', ...task,
    })) }), 'inferred/.vscode/tasks.json').tasks;
    assert.deepEqual(tasks.map(task => task.group), expected, JSON.stringify(definitions));
  }
});

test('core resolves only selected graph nodes with folder-scoped configuration', () => {
  const root = resolve('variable-workspace');
  const source = parseTaskFile(JSON.stringify({ tasks: [
    { label: 'build', dependsOn: ['ws:first', 'ws:shared'] },
    { label: 'unselected', command: '${config:missing}' },
  ] }), join(root, 'app', '.vscode', 'tasks.json')).tasks.map(task => core.identifyTask(root, task));
  const targets = ['first', 'shared'].map(folder => core.identifyTask(root,
    parseTaskFile(JSON.stringify({ tasks: [{ label: folder, command: '${env:TOOL}', args: ['${config:probe.value}'],
      ...(folder === 'first' ? { dependsOn: 'ws:shared' } : {}),
    }] }), join(root, folder, '.vscode', 'tasks.json')).tasks[0]));
  const plan = core.planNativeTask([...source, ...targets], source[0]);
  const result = core.resolveTaskPlanVariables(plan, {
    environment: { TOOL: 'probe' },
    getConfigurationValue: (section, folder) => {
      assert.equal(section, 'probe.value');
      return folder;
    },
  });
  assert.deepEqual(result.dependencies.map(node => node.task.configuration.args), [[join(root, 'first')], [join(root, 'shared')]]);
  assert.ok(result.dependencies.every(node => node.task.configuration.command === 'probe'));
  assert.equal(result.dependencies[0].dependencies[0], result.dependencies[1]);
  assert.equal(result.task.canonicalIdentity, plan.task.canonicalIdentity);
  assert.equal(result.task.configuration.command, undefined);
  assert.equal(plan.dependencies[0].task.configuration.command, '${env:TOOL}');
});

test('core routes editor, provider, and host variables to their dedicated resolvers', () => {
  const root = resolve('variable-workspace');
  const groups = {
    editor: ['file', 'fileWorkspaceFolder', 'fileWorkspaceFolderBasename', 'relativeFile', 'relativeFileDirname',
      'fileDirname', 'fileExtname', 'fileBasename', 'fileBasenameNoExtension', 'fileDirnameBasename',
      'selectedText', 'lineNumber', 'columnNumber'],
    provider: ['command:tool', 'input:choice', 'extensionInstallFolder:example', 'defaultBuildTask', 'contributed:value'],
    host: ['execPath', 'execInstallFolder'],
  };
  const variables = Object.values(groups).flat();
  const task = core.identifyTask(root, parseTaskFile(JSON.stringify({ tasks: [{
    label: 'probe', command: 'probe', args: variables.map(variable => '${' + variable + '}'),
  }] }), join(root, '.vscode', 'tasks.json')).tasks[0]);
  const context = Object.fromEntries(Object.entries(groups).map(([group]) => [
    `resolve${group[0].toUpperCase()}${group.slice(1)}Variable`,
    reference => `${group}:${reference.name}${reference.arg === undefined ? '' : ':' + reference.arg}`,
  ]));
  const resolved = core.resolveTaskVariables(task, context);
  assert.deepEqual(resolved.configuration.args, Object.entries(groups)
    .flatMap(([group, names]) => names.map(name => `${group}:${name}`)));
});

test('core rejects unresolved required variables with source-located errors', () => {
  const root = resolve('variable-workspace');
  for (const [variable, context] of [
    ['${env}', {}], ['${env:}', {}], ['${config}', {}], ['${config:}', {}],
    ['${config:missing}', {}], ['${config:null}', { configuration: { null: null } }],
    ['${config:object}', { configuration: { object: { secret: 'do-not-log' } } }],
    ['${userHome}', { userHome: '' }],
    ['${env:LOOP}', { environment: { LOOP: '${env:OTHER}', OTHER: '${env:LOOP}' } }],
    ['${file}', {}], ['${input:choice}', {}], ['${command:tool}', {}],
    ['${execPath}', {}], ['${extensionInstallFolder:example}', {}], ['${unknown}', {}],
    ['${file}', { resolveEditorVariable: () => undefined }],
    ['${input:choice}', { resolveProviderVariable: () => undefined }],
    ['${execPath}', { resolveHostVariable: () => undefined }],
  ]) {
    const task = core.identifyTask(root, parseTaskFile(JSON.stringify({ tasks: [{ label: 'probe', command: variable }] }),
      join(root, '.vscode', 'tasks.json')).tasks[0]);
    assert.throws(() => core.resolveTaskVariables(task, context), error => {
      assert.ok(error.message.startsWith(`${task.source.file}:${task.source.line}:${task.source.column}:`));
      assert.match(error.message, /resolve.*variable/iu);
      assert.ok(!error.message.includes('do-not-log'));
      return true;
    }, variable);
  }
});

test('core environment lookup agrees with pinned Windows and POSIX rules', async () => {
  const root = resolve('variable-workspace');
  const configuration = {
    label: '${env:TOOL}', dependsOn: '${env:DEPENDENCY}',
    command: '${env:TOOL}', args: ['${env:VALUE}', '${env:UNSET}'],
    options: { env: { VALUE: 'task', COPY: '${env:VALUE}' } },
  };
  const task = core.identifyTask(root, parseTaskFile(JSON.stringify({ tasks: [configuration] }),
    join(root, 'app', '.vscode', 'tasks.json')).tasks[0]);
  for (const [platform, environment] of [
    ['darwin', { TOOL: 'probe', VALUE: 'parent' }],
    ['win32', { tool: 'probe', value: 'parent' }],
    ['win32', { TOOL: 'earlier', tool: 'probe', VALUE: 'earlier', value: 'parent' }],
    ['darwin', { tool: 'probe', value: 'parent' }],
  ]) {
    const result = core.resolveTaskVariables(task, { platform, environment });
    const baseline = baselineResolver(join(root, 'app'), {}, environment, platform);
    const expected = await baseline.resolveAsync({ uri: { fsPath: join(root, 'app') } }, {
      command: configuration.command, args: configuration.args, options: configuration.options,
    });
    assert.deepEqual({ command: result.configuration.command, args: result.configuration.args,
      options: { env: result.configuration.options.env } }, expected, platform);
  }
});

test('core plans exact same-root ws dependencies with target-file native lookup', () => {
  const root = resolve('dependency-workspace');
  const source = parseTaskFile(JSON.stringify({ tasks: [
    { label: 'build', dependsOn: 'ws:prepare' },
    { label: 'local', command: 'source-local' },
  ] }), join(root, 'app', '.vscode', 'tasks.json')).tasks.map(task => core.identifyTask(root, task));
  const target = parseTaskFile(JSON.stringify({ tasks: [
    { label: 'prepare', dependsOn: 'local' },
    { label: 'local', command: 'target-local' },
  ] }), join(root, 'tools', '.vscode', 'tasks.json')).tasks.map(task => core.identifyTask(root, task));
  const otherRoot = resolve('other-workspace');
  const unrelated = parseTaskFile(JSON.stringify({ tasks: [{ label: 'prepare' }] }),
    join(otherRoot, '.vscode', 'tasks.json')).tasks.map(task => core.identifyTask(otherRoot, task));
  const plan = core.planNativeTask([...unrelated, ...source, ...target], source[0]);

  assert.equal(plan.dependencies[0].task, target[0]);
  assert.equal(plan.dependencies[0].dependencies[0].task, target[1]);
});

test('core qualified ws references select duplicate labels despite local prefix collisions', () => {
  const root = resolve('dependency-workspace');
  const label = 'prepare:# build';
  const source = parseTaskFile(JSON.stringify({ tasks: [
    { label: 'build', dependsOn: [`ws:${label}`, `ws:tools/.vscode/tasks.json#${encodeURIComponent(label)}`] },
    { label: `ws:${label}`, command: 'local' },
  ] }), join(root, 'app', '.vscode', 'tasks.json')).tasks.map(task => core.identifyTask(root, task));
  const targets = ['tools', 'other'].flatMap(folder => parseTaskFile(JSON.stringify({ tasks: [{ label }] }),
    join(root, folder, '.vscode', 'tasks.json')).tasks.map(task => core.identifyTask(root, task)));
  const plan = core.planNativeTask([...source, ...targets], source[0]);

  assert.deepEqual(plan.dependencies.map(node => node.task), [source[1], targets[0]]);
});

test('core ambiguous ws dependencies report usable qualified references before returning a plan', () => {
  const root = resolve('dependency-workspace');
  const targets = ['tools', 'other'].flatMap(folder => parseTaskFile(JSON.stringify({ tasks: [{ label: 'prepare' }] }),
    join(root, folder, '.vscode', 'tasks.json')).tasks.map(task => core.identifyTask(root, task)));
  for (const collisions of [[], [
    { label: `ws:${targets[0].qualifiedSelector}` },
    { label: 'alias', identifier: `ws:${targets[1].qualifiedSelector}` },
  ], targets.flatMap(task => [
    { label: `ws:${task.qualifiedSelector}` },
    { label: `ws:${task.canonicalIdentity}` },
  ])]) {
    const local = parseTaskFile(JSON.stringify({ tasks: [
      { label: 'build', dependsOn: 'ws:prepare' }, ...collisions,
    ] }), join(root, 'app', '.vscode', 'tasks.json')).tasks.map(task => core.identifyTask(root, task));
    const source = local[0];
    let suggestions;
    assert.throws(() => core.planNativeTask([...local, ...targets], source), error => {
      assert.match(error.message, /Ambiguous dependency "ws:prepare".*"build"/u);
      assert.ok(error.message.startsWith(`${source.source.file}:1:`));
      suggestions = error.message.split('\n').slice(1);
      if (collisions.length === 4) {
        assert.match(error.message, /local label or identifier collisions.*No usable qualified references/u);
        assert.deepEqual(suggestions, []);
      } else {
        assert.deepEqual(suggestions, targets.map(task => `ws:${collisions.length ? task.canonicalIdentity : task.qualifiedSelector}`));
      }
      return true;
    });
    for (const [index, reference] of suggestions.entries()) {
      const selected = { ...source, configuration: { ...source.configuration, dependsOn: reference } };
      const plan = core.planNativeTask([selected, ...local.slice(1), ...targets], selected);
      assert.equal(plan.dependencies[0].task, targets[index]);
    }
  }
});

test('core plans exact native dependencies within the selected task file', () => {
  const root = resolve('dependency-workspace');
  const file = join(root, 'app', '.vscode', 'tasks.json');
  const tasks = parseTaskFile(JSON.stringify({ version: '2.0.0', tasks: [
    { label: 'build', dependsOn: ['prepare', 'ws:local'] },
    { label: 'prepare', command: 'prepare' },
    { label: 'ws:local', command: 'local' },
    { label: 'unselected', dependsOn: 'missing' },
  ] }), file).tasks.map(task => core.identifyTask(root, task));
  const otherFile = parseTaskFile(JSON.stringify({ tasks: [
    { label: 'prepare', command: 'other' },
  ] }), join(root, 'other', '.vscode', 'tasks.json')).tasks.map(task => core.identifyTask(root, task));
  const plan = core.planNativeTask([...otherFile, ...tasks], tasks[0]);

  assert.equal(plan.task, tasks[0]);
  assert.equal(plan.dependsOrder, 'parallel');
  assert.deepEqual(plan.dependencies.map(node => node.task), [tasks[1], tasks[2]]);
  assert.deepEqual(plan.dependencies.map(node => node.dependencies), [[], []]);
});

test('core native plans preserve dependency order and reuse shared task nodes', () => {
  const root = resolve('dependency-workspace');
  for (const order of ['sequence', 'parallel', undefined, 'unknown']) {
    const tasks = parseTaskFile(JSON.stringify({ tasks: [
      { label: 'build', dependsOn: ['first', 'second', 'first'], dependsOrder: order },
      { label: 'first', dependsOn: 'shared' },
      { label: 'second', dependsOn: 'shared' },
      { label: 'shared', command: 'shared' },
    ] }), join(root, '.vscode', 'tasks.json')).tasks.map(task => core.identifyTask(root, task));
    const plan = core.planNativeTask(tasks, tasks[0]);

    assert.equal(plan.dependsOrder, order === 'sequence' ? 'sequence' : 'parallel');
    assert.deepEqual(plan.dependencies.map(node => node.task.label), ['first', 'second', 'first']);
    assert.equal(plan.dependencies[0], plan.dependencies[2]);
    assert.equal(plan.dependencies[0].dependencies[0], plan.dependencies[1].dependencies[0]);
  }
});

test('core rejects missing native and extended targets and cycles before returning a selected plan', () => {
  const root = resolve('dependency-workspace');
  const file = join(root, 'app', '.vscode', 'tasks.json');
  const cases = [
    { tasks: [{ label: 'build', dependsOn: 'missing' }], message: /Missing dependency "missing".*"build"/u },
    { tasks: [{ label: 'build', dependsOn: 'Build' }], message: /Missing dependency "Build"/u },
    { tasks: [{ label: 'build', dependsOn: 'external' }], message: /Missing dependency "external"/u },
    { tasks: [{ label: 'build', dependsOn: 'ws:External' }], message: /Missing dependency "ws:External"/u },
    { tasks: [{ label: 'build', dependsOn: 'ws:externl' }], message: /Missing dependency "ws:externl"/u },
    { tasks: [{ label: 'build', dependsOn: 'ws:isolated' }], message: /Missing dependency "ws:isolated"/u },
    { tasks: [{ label: 'build', dependsOn: 'ws:foreign/.vscode/tasks.json#isolated' }],
      message: /Missing dependency "ws:foreign\/\.vscode\/tasks.json#isolated"/u },
    { tasks: [{ label: 'build', dependsOn: `ws:vstask:${[resolve('other-workspace'), 'foreign/.vscode/tasks.json', 'isolated']
      .map(value => encodeURIComponent(value)).join(':')}` }], message: /Missing dependency.*ws:vstask:/u },
    { tasks: [{ label: 'build', dependsOn: 'ws:external' }], otherTasks: [{ label: 'external', dependsOn: 'ws:build' }],
      message: /Dependency cycle.*build.*external.*build/u },
    { tasks: [{ label: 'build', dependsOn: 'build' }], message: /Dependency cycle.*build.*build/u },
    { tasks: [{ label: 'build', dependsOn: 'prepare' }, { label: 'prepare', dependsOn: 'build' }],
      message: /Dependency cycle.*build.*prepare.*build/u },
    { tasks: [{ label: 'build', dependsOn: ['good', 'bad'], dependsOrder: 'sequence' },
      { label: 'good', command: 'good' }, { label: 'bad', dependsOn: 'bad' }],
      message: /Dependency cycle.*bad.*bad/u },
  ];
  for (const entry of cases) {
    const tasks = parseTaskFile(JSON.stringify({ tasks: entry.tasks }), file).tasks.map(task => core.identifyTask(root, task));
    const unrelated = [
      ...parseTaskFile(JSON.stringify({ tasks: entry.otherTasks ?? [{ label: 'external', command: 'other' }] }),
        join(root, 'other', '.vscode', 'tasks.json')).tasks.map(task => core.identifyTask(root, task)),
      ...parseTaskFile(JSON.stringify({ tasks: [{ label: 'external', command: 'other-root' }, { label: 'isolated' }] }),
        join(resolve('other-workspace'), 'foreign', '.vscode', 'tasks.json'))
        .tasks.map(task => core.identifyTask(resolve('other-workspace'), task)),
    ];
    assert.throws(() => core.planNativeTask([...unrelated, ...tasks], tasks[0]), error => {
      assert.match(error.message, entry.message);
      assert.ok(error.message.includes(`${file}:1:`));
      return true;
    });
  }
});

test('core resolves duplicate labels and local identifier aliases against the pinned grouped resolver', () => {
  const root = resolve('dependency-workspace');
  const tasks = parseTaskFile(JSON.stringify({ tasks: [
    { label: 'build', dependsOn: ['duplicate', 'alias', 'ws:local'] },
    { label: 'duplicate', command: 'first' },
    { label: 'duplicate', command: 'last' },
    { label: 'identifier-only', identifier: 'alias', command: 'alias' },
    { label: 'identifier-collision', identifier: 'duplicate', command: 'not-label' },
    { label: 'alias-collision', identifier: 'ws:local', command: 'not-local' },
    { label: 'ws:local', command: 'local' },
  ] }), join(root, '.vscode', 'tasks.json')).tasks.map(task => core.identifyTask(root, task));
  const plan = core.planNativeTask(tasks, tasks[0]);

  assert.deepEqual(plan.dependencies.map(node => node.task), [tasks[2], tasks[3], tasks[6]]);
  const consumer = core.identifyTask(root, parseTaskFile(JSON.stringify({ tasks: [
    { label: 'consumer', dependsOn: ['ws:duplicate', `ws:${tasks[2].qualifiedSelector}`] },
  ] }), join(root, 'consumer', '.vscode', 'tasks.json')).tasks[0]);
  const extended = core.planNativeTask([consumer, ...tasks], consumer);
  assert.deepEqual(extended.dependencies.map(node => node.task), [tasks[2], tasks[2]]);
});

test('shared task model preserves unresolved built-in configuration', () => {
  const fixture = new URL('../fixtures/built-in/.vscode/tasks.json', import.meta.url);
  const text = readFileSync(fixture, 'utf8');
  const expected = JSON.parse(text);
  const parsed = parseTaskFile(text, fixture.pathname);

  assert.deepEqual(JSON.parse(JSON.stringify(parsed.configuration)), expected);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.tasks.map(task => task.configuration))), expected.tasks);
});

test('core resolves nested task paths without changing discovery identity or parsed configuration', () => {
  const root = resolve('workspace');
  const project = join(root, 'apps', 'client');
  const configuration = {
    label: '${workspaceFolder}:build',
    dependsOn: '${workspaceFolder}:prepare',
    command: '${workspaceFolder}/bin/build',
    args: ['${workspaceFolderBasename}', '${cwd}', '${env:OUTPUT}', '${file}'],
    options: { env: { PROJECT: '${workspaceRoot}', NAME: '${workspaceRootFolderName}' } },
  };
  const parsed = parseTaskFile(JSON.stringify({ version: '2.0.0', tasks: [configuration] }), join(project, '.vscode', 'tasks.json'));
  const task = core.identifyTask(root, parsed.tasks[0]);
  const result = core.resolveTaskPaths(task);

  assert.equal(result.taskWorkspaceFolder, project);
  assert.equal(result.discoveryRoot, root);
  assert.equal(result.canonicalIdentity, task.canonicalIdentity);
  assert.equal(result.qualifiedSelector, task.qualifiedSelector);
  assert.equal(result.configuration.label, configuration.label);
  assert.equal(result.configuration.dependsOn, configuration.dependsOn);
  assert.equal(result.configuration.command, `${project}/bin/build`);
  assert.deepEqual(result.configuration.args, ['client', project, '${env:OUTPUT}', '${file}']);
  assert.deepEqual(result.configuration.options.env, { PROJECT: project, NAME: 'client' });
  assert.deepEqual(JSON.parse(JSON.stringify(task.configuration)), configuration);
});

test('core resolves named workspace folders only within the source discovery root', () => {
  const firstRoot = resolve('first-workspace');
  const secondRoot = resolve('second-workspace');
  const configuration = {
    label: 'build',
    command: '${workspaceFolder:tools}/build',
    args: ['${workspaceRoot:tools}', '${cwd:tools}', '${workspaceFolderBasename:tools}', '${workspaceRootFolderName:tools}'],
    options: { cwd: '${workspaceFolder:tools}/output' },
  };
  const context = { workspaceFolders: [
    { discoveryRoot: firstRoot, name: 'tools', path: join(firstRoot, 'shared') },
    { discoveryRoot: secondRoot, name: 'tools', path: join(secondRoot, 'other') },
  ] };
  const tasks = [firstRoot, secondRoot].map(root => core.identifyTask(root,
    parseTaskFile(JSON.stringify({ tasks: [configuration] }), join(root, 'app', '.vscode', 'tasks.json')).tasks[0]));

  for (const [index, folder, name] of [[0, join(firstRoot, 'shared'), 'shared'], [1, join(secondRoot, 'other'), 'other']]) {
    const result = core.resolveTaskPaths(tasks[index], context);
    assert.equal(result.configuration.command, `${folder}/build`);
    assert.deepEqual(result.configuration.args, [folder, folder, name, name]);
    assert.equal(result.configuration.options.cwd, `${folder}/output`);
    assert.equal(result.discoveryRoot, tasks[index].discoveryRoot);
    assert.equal(result.canonicalIdentity, tasks[index].canonicalIdentity);
  }
  assert.notEqual(tasks[0].canonicalIdentity, tasks[1].canonicalIdentity);
  assert.throws(() => core.resolveTaskPaths(tasks[0], { workspaceFolders: context.workspaceFolders.slice(1) }), /No workspace folder.*tools/u);
  assert.throws(() => core.resolveTaskPaths(tasks[0], { workspaceFolders: [context.workspaceFolders[0],
    { discoveryRoot: firstRoot, name: 'tools', path: join(firstRoot, 'duplicate') }] }), /Ambiguous workspace folder.*tools/u);
});

test('core task cwd paths match the pinned baseline when a task file moves', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/workspace-paths.json', import.meta.url), 'utf8'));
  const root = resolve('path-workspace');
  for (const project of [root, join(root, 'apps', 'client')]) {
    const paths = { root, project, parent: dirname(project) };
    function expectedPath(value) {
      return value.replace(/<(root|project|parent)>/gu, (_match, name) => paths[name]).split('/').join(sep);
    }
    for (const entry of fixture.cases) {
      const configuration = { label: entry.name, type: 'process', command: './build', args: ['./input'] };
      if (entry.options !== null) {
        configuration.options = { ...entry.options };
        if (typeof configuration.options.cwd === 'string' && configuration.options.cwd.startsWith('<')) {
          configuration.options.cwd = expectedPath(configuration.options.cwd);
        }
      }
      const task = core.identifyTask(root, parseTaskFile(JSON.stringify({ tasks: [configuration] }),
        join(project, '.vscode', 'tasks.json')).tasks[0]);
      const result = core.resolveTaskPaths(task);
      assert.equal(result.configuration.options.cwd, expectedPath(entry.cwd), `${project}: ${entry.name}`);
      assert.equal(result.taskWorkspaceFolder, project);
      assert.equal(result.configuration.command, './build');
      assert.deepEqual(result.configuration.args, ['./input']);
      if (entry.options?.env) {
        assert.equal(result.configuration.options.env.OUT, `${project}/out`);
      }
    }
  }
});