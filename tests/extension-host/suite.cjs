const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async function () {
	const extension = vscode.extensions.all.find(candidate => candidate.packageJSON.name === 'vstask');
	assert.ok(extension, 'The extension is available.');
	await extension.activate();
	const tasks = await vscode.tasks.fetchTasks({ type: 'vstask' });
	assert.equal(tasks.length, 4, 'Nested tasks are listed without resolving unselected inputs.');
	const root = process.env.VSTASK_TEST_ROOT;
	const file = path.join(root, '.vscode', 'tasks.json');
	const original = await readFile(file, 'utf8');
	for (const [label, value, exitCode, executionType] of [
		['native process', 'process', 0, vscode.ProcessExecution],
		['native shell', 'shell', 7, vscode.ShellExecution],
		['custom shell', 'custom', 3, vscode.CustomExecution],
	]) {
		const task = tasks.find(candidate => candidate.name === label);
		assert.ok(task.execution instanceof executionType, label);
		assert.match(task.definition.identity, /^vstask:/);
		const result = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => { subscription.dispose(); reject(new Error(`Task timeout: ${label}`)); }, 20000);
			const subscription = vscode.tasks.onDidEndTaskProcess(event => {
				if (event.execution.task.definition.identity === task.definition.identity) {
					clearTimeout(timer); subscription.dispose(); resolve(event.exitCode);
				}
			});
			vscode.tasks.executeTask(task).catch(error => { clearTimeout(timer); subscription.dispose(); reject(error); });
		});
		assert.equal(result, exitCode, label);
		assert.ok(vscode.window.terminals.some(terminal => terminal.name.includes(label)), 'Execution uses an integrated terminal.');
		const output = JSON.parse(await readFile(path.join(root, `${value}.json`), 'utf8'));
		const cli = spawnSync(process.env.VSTASK_TEST_NODE, [path.resolve(__dirname, '../../packages/cli/dist/index.js'), 'run', label, '--file', file], { encoding: 'utf8' });
		assert.equal(cli.status, exitCode, cli.stderr);
		assert.deepEqual(output, JSON.parse(cli.stdout));
	}
	assert.equal(await readFile(file, 'utf8'), original, 'Task files remain unchanged.');
	await testCatalogRefresh(tasks, root);
	await testTaskGroups(root);
	await testEditorContext(root);
	await testCancellation(root);
};

async function testEditorContext(root) {
	const directory = path.join(root, 'editor-context');
	const source = path.join(directory, '.vscode', 'tasks.json');
	const output = path.join(directory, 'editor.json');
	const variables = ['file', 'fileWorkspaceFolder', 'fileWorkspaceFolderBasename', 'relativeFile', 'relativeFileDirname',
		'fileDirname', 'fileExtname', 'fileBasename', 'fileBasenameNoExtension', 'fileDirnameBasename',
		'selectedText', 'lineNumber', 'columnNumber'];
	try {
		await mkdir(path.dirname(source), { recursive: true });
		await writeFile(source, JSON.stringify({ version: '2.0.0', tasks: [{ label: 'editor context probe', type: 'process',
			command: process.env.VSTASK_TEST_NODE,
			args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(1)));`,
				...variables.map(name => '${' + name + '}')],
		}] }));
		const task = await until(async () => {
			const listed = await vscode.tasks.fetchTasks({ type: 'vstask' });
			const selected = listed.find(candidate => candidate.name === 'editor context probe');
			assert.ok(selected);
			return selected;
		});
		for (const filename of ['first.test.ts', 'second.txt']) {
			const activeFile = path.join(directory, filename);
			await writeFile(activeFile, 'first line\nselected value\nlast line\n');
			const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(activeFile));
			editor.selection = new vscode.Selection(1, 8, 1, 0);
			await runGroupCommand('workbench.action.tasks.runTask', task, task.definition);
			assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), [activeFile, root, path.basename(root), filename, '.',
				directory, path.extname(filename), filename, path.basename(filename, path.extname(filename)), 'editor-context',
				'selected', '2', '1']);
		}
	} finally {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await rm(directory, { recursive: true, force: true });
	}
}

async function testTaskGroups(root) {
	const directory = path.join(root, 'groups');
	const source = path.join(directory, '.vscode', 'tasks.json');
	const duplicateSource = path.join(directory, 'other', '.vscode', 'tasks.json');
	const output = path.join(directory, 'selected.txt');
	const definition = (label, value, group, custom = false) => ({ label, type: 'process', command: process.env.VSTASK_TEST_NODE,
		args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(output)}, ${JSON.stringify(value + '\n')});`], group,
		...(custom ? { options: { cwd: '${workspaceFolder}' } } : {}) });
	const original = JSON.stringify({ version: '2.0.0', tasks: [
		definition('group build', 'default build', { kind: 'build', isDefault: true }),
		definition('group test', 'default test', { kind: 'test', isDefault: true }, true),
		definition('pattern build', 'pattern build', { kind: 'build', isDefault: '**/*.ts' }, true),
		definition('pattern test', 'pattern test', { kind: 'test', isDefault: '**/*.ts' }),
	] });
	try {
		await mkdir(path.dirname(source), { recursive: true });
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await writeFile(source, original);
		await mkdir(path.dirname(duplicateSource), { recursive: true });
		await writeFile(duplicateSource, JSON.stringify({ version: '2.0.0', tasks: [
			definition('group build', 'other build', 'build'),
		] }));
		const tasks = await until(async () => {
			const current = await vscode.tasks.fetchTasks({ type: 'vstask' });
			assert.equal(current.filter(task => task.name === 'group build').length, 2);
			return current;
		});
		const builds = tasks.filter(task => task.name === 'group build');
		assert.equal(new Set(builds.map(task => task.definition.identity)).size, 2);
		assert.deepEqual(builds.map(task => task.detail).sort(), [
			'groups/.vscode/tasks.json#group%20build', 'groups/other/.vscode/tasks.json#group%20build',
		]);
		const defaultBuild = builds.find(task => task.group?.isDefault === true);
		const otherBuild = builds.find(task => task.group?.isDefault !== true);
		const defaultTest = tasks.find(task => task.name === 'group test');
		assert.ok(builds.every(task => task.group?.id === 'build'));
		assert.equal(defaultTest.group?.id, 'test');
		assert.equal(defaultTest.group?.isDefault, true);
		for (const [command, selected, argument] of [
			['workbench.action.tasks.build', defaultBuild],
			['workbench.action.tasks.test', defaultTest],
			['workbench.action.tasks.runTask', otherBuild, otherBuild.definition],
		]) {
			await runGroupCommand(command, selected, argument);
		}
		assert.equal(await readFile(output, 'utf8'), 'default build\ndefault test\nother build\n');
		for (const filename of ['example.ts', 'example.txt', undefined, 'untitled']) {
			if (filename === 'untitled') {
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'typescript' }));
			} else if (filename) {
				const file = path.join(directory, filename);
				await writeFile(file, '');
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
			} else await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			const prefix = filename?.endsWith('.ts') ? 'pattern' : 'group';
			const current = await until(async () => {
				const listed = await vscode.tasks.fetchTasks({ type: 'vstask' });
				assert.deepEqual(listed.filter(task => task.group?.isDefault).map(task => task.name).sort(), [`${prefix} build`, `${prefix} test`]);
				return listed;
			});
			for (const kind of ['build', 'test']) {
				await runGroupCommand(`workbench.action.tasks.${kind}`, current.find(task => task.name === `${prefix} ${kind}`));
			}
		}
		assert.equal(await readFile(output, 'utf8'), 'default build\ndefault test\nother build\npattern build\npattern test\ndefault build\ndefault test\ndefault build\ndefault test\ndefault build\ndefault test\n');
		assert.equal(await readFile(source, 'utf8'), original, 'Group commands do not modify task files.');
		const multiple = JSON.parse(original);
		multiple.tasks.push(definition('second pattern build', 'second pattern build', { kind: 'build', isDefault: '**/*.ts' }));
		const multipleSource = JSON.stringify(multiple);
		await writeFile(source, multipleSource);
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(directory, 'example.ts')));
		await until(async () => {
			const listed = await vscode.tasks.fetchTasks({ type: 'vstask' });
			assert.deepEqual(listed.filter(task => task.group?.isDefault).map(task => task.name).sort(),
				['pattern build', 'pattern test', 'second pattern build'], 'Multiple pattern defaults retain separate choices.');
		});
		assert.equal(await readFile(source, 'utf8'), multipleSource);
	} finally {
		await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await rm(directory, { recursive: true, force: true });
	}
}

async function runGroupCommand(command, selected, argument) {
	assert.ok(selected, `Selected task exists: ${command}`);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => { subscription.dispose(); reject(new Error(`Group command timeout: ${command}`)); }, 20000);
		const subscription = vscode.tasks.onDidEndTaskProcess(event => {
			if (event.execution.task.definition.identity === selected.definition.identity) {
				clearTimeout(timer); subscription.dispose();
				try { assert.equal(event.exitCode, 0); resolve(); } catch (error) { reject(error); }
			}
		});
		vscode.commands.executeCommand(command, argument).then(undefined, error => {
			clearTimeout(timer); subscription.dispose(); reject(error);
		});
	});
}

async function until(check) {
	const deadline = Date.now() + 10000;
	for (;;) {
		try { return await check(); }
		catch (error) {
			if (Date.now() >= deadline) throw error;
			await new Promise(resolve => setTimeout(resolve, 50));
		}
	}
}

async function testCancellation(root) {
	const directory = path.join(root, 'cancellation');
	const source = path.join(directory, '.vscode', 'tasks.json');
	const worker = path.join(directory, 'tree.cjs');
	await mkdir(path.dirname(source), { recursive: true });
	await writeFile(worker, `const fs = require('node:fs');
const { spawn } = require('node:child_process');
fs.appendFileSync(process.argv[2], process.pid + '\\n');
if (Number(process.argv[3]) > 0) spawn(process.execPath, [__filename, process.argv[2], String(Number(process.argv[3]) - 1)], { stdio: 'inherit' });
setInterval(() => {}, 1000);
`);
	const definitions = [
		['cancel native process', 'process', false], ['cancel native shell', 'shell', false],
		['cancel custom process', 'process', true], ['cancel custom shell', 'shell', true],
	].map(([label, type, custom]) => ({ label, type, command: process.env.VSTASK_TEST_NODE,
		args: [custom ? { value: worker, quoting: 'strong' } : worker, path.join(directory, `${label}.pids`), '2'] }));
	const controlFile = path.join(directory, 'control.pids');
	definitions.push({ label: 'unrelated control', type: 'process', command: process.env.VSTASK_TEST_NODE,
		args: [worker, controlFile, '0'] });
	const running = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
	const readPids = async file => (await readFile(file, 'utf8')).trim().split('\n').map(Number);
	const executions = [];
	const results = new Map();
	const subscription = vscode.tasks.onDidEndTaskProcess(event => results.set(event.execution, event.exitCode));
	try {
		await writeFile(source, JSON.stringify({ version: '2.0.0', tasks: definitions }));
		const tasks = await until(async () => {
			const current = await vscode.tasks.fetchTasks({ type: 'vstask' });
			assert.ok(definitions.every(definition => current.some(task => task.name === definition.label)));
			return current;
		});
		const control = await vscode.tasks.executeTask(tasks.find(task => task.name === 'unrelated control'));
		executions.push(control);
		const controlPids = await until(async () => { const pids = await readPids(controlFile); assert.equal(pids.length, 1); return pids; });
		for (const definition of definitions.slice(0, -1)) {
			const task = tasks.find(task => task.name === definition.label);
			assert.ok(task.execution instanceof (definition.label.includes('custom') ? vscode.CustomExecution
				: definition.type === 'process' ? vscode.ProcessExecution : vscode.ShellExecution), definition.label);
			const execution = await vscode.tasks.executeTask(task);
			executions.push(execution);
			const owned = await until(async () => { const pids = await readPids(path.join(directory, `${definition.label}.pids`)); assert.equal(pids.length, 3); return pids; });
			execution.terminate();
			await until(() => {
				assert.ok(results.has(execution), 'Cancellation reports completion.');
				assert.notEqual(results.get(execution), 0, 'Cancellation is not success.');
				assert.ok(owned.every(pid => !running(pid)), `${definition.label}: cancellation stops owned descendants (${owned.filter(running).join(', ')}).`);
			});
			assert.equal(await readFile(path.join(directory, `${definition.label}.pids`), 'utf8'), owned.map(pid => `${pid}\n`).join(''), 'Cancellation does not restart work.');
			assert.ok(controlPids.every(running), 'An unrelated process remains active.');
			assert.ok(vscode.tasks.taskExecutions.includes(control), 'An unrelated task execution remains active.');
		}
	} finally {
		for (const execution of executions) execution.terminate();
		for (const definition of definitions) {
			const file = definition.label === 'unrelated control' ? controlFile : path.join(directory, `${definition.label}.pids`);
			for (const pid of await readPids(file).catch(() => [])) { try { process.kill(pid, 'SIGKILL'); } catch {} }
		}
		subscription.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}

async function testCatalogRefresh(tasks, root) {
	const externalRoot = await mkdtemp(path.join(tmpdir(), 'vstask-catalog-'));
	const directory = path.join(root, 'catalog', '.vscode');
	const source = path.join(directory, 'tasks.json');
	const started = path.join(root, 'catalog-started.txt');
	const activeTask = { label: 'catalog active', type: 'process', command: process.env.VSTASK_TEST_NODE,
		args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(started)}, process.pid + '\\n'); setInterval(() => {}, 1000);`] };
	const expected = tasks.map(task => task.name);
	const catalog = names => until(async () => {
		const current = await vscode.tasks.fetchTasks({ type: 'vstask' });
		assert.deepEqual(current.map(task => task.name).sort(), [...names].sort());
		assert.equal(new Set(current.map(task => task.definition.identity)).size, current.length, 'Catalog identities are unique.');
		for (const task of current) {
			const original = tasks.find(candidate => candidate.name === task.name);
			if (original) assert.equal(task.definition.identity, original.definition.identity, 'Unchanged identities survive refresh.');
		}
		return current;
	});
	const configuration = vscode.workspace.getConfiguration('vstask');
	let execution;
	let ended = false;
	const subscription = vscode.tasks.onDidEndTask(event => {
		if (event.execution === execution) ended = true;
	});
	try {
		await mkdir(directory, { recursive: true });
		const writeTasks = label => writeFile(source, JSON.stringify({ version: '2.0.0', tasks: [activeTask,
			{ label, type: 'process', command: process.env.VSTASK_TEST_NODE, args: ['-e', 'process.exit(0)'] },
		] }));
		await writeTasks('added');
		const added = await catalog([...expected, 'catalog active', 'added']);
		execution = await vscode.tasks.executeTask(added.find(task => task.name === 'catalog active'));
		const initialStart = await until(async () => {
			const value = await readFile(started, 'utf8');
			assert.match(value, /^\d+\n$/);
			return value;
		});
		await writeTasks('edited');
		const edited = await catalog([...expected, 'catalog active', 'edited']);
		assert.equal(edited.find(task => task.name === 'catalog active').definition.identity,
			added.find(task => task.name === 'catalog active').definition.identity);
		await rm(source);
		await catalog(expected);
		await configuration.update('exclude', ['nested'], vscode.ConfigurationTarget.Workspace);
		await catalog(expected.filter(name => name !== 'unselected input'));
		await configuration.update('exclude', undefined, vscode.ConfigurationTarget.Workspace);
		await configuration.update('roots', ['nested', 'nested'], vscode.ConfigurationTarget.Workspace);
		const scoped = await until(async () => {
			const current = await vscode.tasks.fetchTasks({ type: 'vstask' });
			assert.deepEqual(current.map(task => task.name), ['unselected input'], 'Changed roots limit discovery without duplicate tasks.');
			return current;
		});
		assert.notEqual(scoped[0].definition.identity, tasks.find(task => task.name === 'unselected input').definition.identity,
			'Changing the discovery root changes canonical identity.');
		await configuration.update('roots', [], vscode.ConfigurationTarget.Workspace);
		await catalog([]);
		await configuration.update('roots', undefined, vscode.ConfigurationTarget.Workspace);
		await catalog(expected);
		const excludedSource = path.join(root, 'node_modules', 'package', '.vscode', 'tasks.json');
		await mkdir(path.dirname(excludedSource), { recursive: true });
		const writeExcluded = label => writeFile(excludedSource, JSON.stringify({ version: '2.0.0', tasks: [
			{ label, type: 'process', command: process.env.VSTASK_TEST_NODE, args: ['-e', 'process.exit(0)'] },
		] }));
		await writeExcluded('default excluded');
		await catalog(expected);
		await configuration.update('useDefaultExclusions', false, vscode.ConfigurationTarget.Workspace);
		await catalog([...expected, 'default excluded']);
		await writeExcluded('override edited');
		await catalog([...expected, 'override edited']);
		await rm(excludedSource);
		await catalog(expected);
		await configuration.update('useDefaultExclusions', undefined, vscode.ConfigurationTarget.Workspace);
		const externalSource = path.join(externalRoot, '.vscode', 'tasks.json');
		await mkdir(path.dirname(externalSource));
		const writeExternal = label => writeFile(externalSource, JSON.stringify({ version: '2.0.0', tasks: [
			{ label, type: 'process', command: process.env.VSTASK_TEST_NODE, args: ['-e', 'process.exit(0)'] },
		] }));
		await writeExternal('external');
		await configuration.update('roots', [externalRoot, externalRoot], vscode.ConfigurationTarget.Workspace);
		await catalog(['external']);
		await writeExternal('external edited');
		await catalog(['external edited']);
		await configuration.update('roots', undefined, vscode.ConfigurationTarget.Workspace);
		await catalog(expected);
		assert.ok(vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders.length, 0, { uri: vscode.Uri.file(externalRoot) }));
		await catalog([...expected, 'external edited']);
		const externalIndex = vscode.workspace.workspaceFolders.findIndex(folder => folder.uri.fsPath === externalRoot);
		assert.ok(externalIndex > 0);
		assert.ok(vscode.workspace.updateWorkspaceFolders(externalIndex, 1));
		await catalog(expected);
		assert.equal(ended, false, 'Catalog changes do not terminate active execution.');
		assert.ok(vscode.tasks.taskExecutions.includes(execution), 'The original execution remains active.');
		assert.equal(await readFile(started, 'utf8'), initialStart, 'Refresh does not restart an active process.');
	} finally {
		for (const setting of ['exclude', 'roots', 'useDefaultExclusions']) {
			if (configuration.inspect(setting)?.workspaceValue !== undefined) {
				await configuration.update(setting, undefined, vscode.ConfigurationTarget.Workspace);
			}
		}
		if (execution) {
			execution.terminate();
			await until(() => assert.equal(ended, true));
		}
		subscription.dispose();
		await rm(externalRoot, { recursive: true, force: true });
	}
}