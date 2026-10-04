import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { discoverTaskFiles, identifyTask, parseTaskFile, planNativeTask, resolveTaskPlanInputs, runProcessTask,
	type DiscoveryOptions, type IdentifiedTask, type TaskGroupDefinition, type TaskInputContext, type VariableResolvedTaskPlan } from '@vstask/core';
import type * as VSCode from 'vscode';

export async function resolveVSCodeTaskPlan(
	tasks: readonly IdentifiedTask[],
	selected: IdentifiedTask,
	context: TaskInputContext = {},
): Promise<VariableResolvedTaskPlan> {
	return resolveTaskPlanInputs(planNativeTask(tasks, selected), context);
}

export function activate(context: VSCode.ExtensionContext): void {
	const vscode: typeof VSCode = require('vscode');
	let roots = configuredRoots(vscode);
	let catalog: Promise<ProvidedTask[]> | undefined;
	let watchers: VSCode.Disposable[] = [];
	const invalidate = () => { catalog = undefined; };
	const watchRoots = () => {
		for (const watcher of watchers) watcher.dispose();
		watchers = [];
		roots = configuredRoots(vscode);
		invalidate();
		for (const root of roots.keys()) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/.vscode/tasks.json'));
			watchers.push(vscode.Disposable.from(watcher, watcher.onDidCreate(invalidate),
				watcher.onDidChange(invalidate), watcher.onDidDelete(invalidate)));
		}
	};
	const provider: VSCode.TaskProvider = {
		async provideTasks() {
			if (!catalog) {
				const pending = loadCatalog(vscode, roots);
				catalog = pending;
				pending.catch(() => { if (catalog === pending) invalidate(); });
			}
			const entries = await catalog;
			const document = vscode.window.activeTextEditor?.document;
			const folder = document && vscode.workspace.getWorkspaceFolder(document.uri);
			const matchingDefaults = new Set(entries.filter(({ group }) => typeof group?.isDefault === 'string'
				&& document && folder && vscode.languages.match({ pattern: new vscode.RelativePattern(folder, group.isDefault) }, document) > 0));
			const matchingGroups = new Set([...matchingDefaults].map(entry => entry.group!.kind));
			return entries.map(entry => {
				const { task, group } = entry;
				if (group) task.group = { id: group.kind, isDefault: typeof group.isDefault === 'string'
					? matchingDefaults.has(entry) : group.isDefault && !matchingGroups.has(group.kind) };
				return task;
			});
		},
		resolveTask() { return undefined; },
	};
	watchRoots();
	context.subscriptions.push(vscode.tasks.registerTaskProvider('vstask', provider),
		vscode.workspace.onDidChangeWorkspaceFolders(watchRoots),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('vstask') || event.affectsConfiguration('files.watcherExclude')) watchRoots();
		}), { dispose() { for (const watcher of watchers) watcher.dispose(); watchers = []; invalidate(); } });
}

interface DiscoveryRoot {
	readonly folder: VSCode.WorkspaceFolder;
	readonly options: DiscoveryOptions;
}

interface ProvidedTask {
	readonly task: VSCode.Task;
	readonly group: TaskGroupDefinition | undefined;
}

function configuredRoots(vscode: typeof VSCode): Map<string, DiscoveryRoot> {
	const roots = new Map<string, DiscoveryRoot>();
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const configuration = vscode.workspace.getConfiguration('vstask', folder.uri);
		for (const directory of configuration.get<string[]>('roots', ['.'])) {
			const root = resolve(folder.uri.fsPath, directory);
			if (!roots.has(root)) roots.set(root, { folder, options: {
				exclude: configuration.get<string[]>('exclude', []),
				useDefaultExclusions: configuration.get<boolean>('useDefaultExclusions', true),
			} });
		}
	}
	return roots;
}

async function loadCatalog(vscode: typeof VSCode, roots: ReadonlyMap<string, DiscoveryRoot>): Promise<ProvidedTask[]> {
	const tasks: IdentifiedTask[] = [];
	for (const [root, { options }] of roots) {
		for (const source of await discoverTaskFiles([root], options)) {
			const parsed = parseTaskFile(await readFile(source.file, 'utf8'), source.file);
			tasks.push(...parsed.tasks.map(task => identifyTask(source.discoveryRoot, task)));
		}
	}
	const result = await Promise.all(tasks.filter(task => task.configuration.dependsOn === undefined
		&& task.configuration.command !== undefined).map(async task => {
			const provided = await createTask(vscode, roots.get(task.discoveryRoot)!.folder, tasks, task);
			if (provided) {
				provided.detail = task.qualifiedSelector;
				return { task: provided, group: task.group };
			}
			return undefined;
		}));
	return result.filter((entry): entry is ProvidedTask => entry !== undefined);
}

async function createTask(vscode: typeof VSCode, folder: VSCode.WorkspaceFolder, tasks: readonly IdentifiedTask[], task: IdentifiedTask): Promise<VSCode.Task | undefined> {
	const prepare = () => {
		const editor = vscode.window.activeTextEditor;
		return resolveVSCodeTaskPlan(tasks, task, {
			getConfigurationValue: (section, workspaceFolder) => vscode.workspace.getConfiguration(undefined, vscode.Uri.file(workspaceFolder)).get(section),
			editorContext: editor && {
				file: editor.document.uri.scheme === 'file' ? editor.document.uri.fsPath : undefined,
				fileWorkspaceFolder: vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath,
				selectedText: editor.document.getText(editor.selection),
				lineNumber: editor.selection.start.line + 1,
				columnNumber: editor.selection.start.character + 1,
			},
		});
	};
	const definition = { type: 'vstask', identity: task.canonicalIdentity };
	if (JSON.stringify([task.configuration, task.fileConfiguration]).includes('${')) {
		return new vscode.Task(definition, folder, task.label, 'vstask', customExecution(vscode, prepare), []);
	}
	const plan = await prepare();
	const configuration = plan.task.configuration;
	const options = configuration.options as { cwd: string; env?: Record<string, string>;
		shell?: { executable?: string; args?: string[]; quoting?: unknown } };
	const args = configuration.args ?? [];
	let execution: VSCode.ProcessExecution | VSCode.ShellExecution | VSCode.CustomExecution;
	if (configuration.type !== 'process' && configuration.type !== 'shell') return undefined;
	if (typeof configuration.command !== 'string' || !Array.isArray(args)
		|| args.some(argument => typeof argument !== 'string') || options.shell?.quoting !== undefined) {
		execution = customExecution(vscode, prepare);
	} else if (configuration.type === 'process') {
		execution = new vscode.ProcessExecution(configuration.command, args as string[], { cwd: options.cwd, env: options.env });
	} else {
		const shellOptions = { cwd: options.cwd, env: options.env, executable: options.shell?.executable, shellArgs: options.shell?.args };
		execution = args.length === 0 ? new vscode.ShellExecution(configuration.command, shellOptions)
			: new vscode.ShellExecution(configuration.command, args as string[], shellOptions);
	}
	return new vscode.Task(definition, folder, task.label, 'vstask', execution, []);
}

function customExecution(vscode: typeof VSCode, prepare: () => Promise<VariableResolvedTaskPlan>): VSCode.CustomExecution {
	return new vscode.CustomExecution(async () => {
		const write = new vscode.EventEmitter<string>();
		const close = new vscode.EventEmitter<number>();
		const controller = new AbortController();
		const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
		const finish = (exitCode: number) => {
			for (const decoder of Object.values(decoders)) write.fire(decoder.end());
			close.fire(exitCode);
			write.dispose(); close.dispose();
		};
		return {
			onDidWrite: write.event,
			onDidClose: close.event,
			open() {
				if (controller.signal.aborted) { finish(130); return; }
				prepare().then(plan => runProcessTask(plan.task, {
					signal: controller.signal,
					onEvent: event => {
						if (event.type === 'output') write.fire(decoders[event.stream].write(Buffer.from(event.data)).replace(/\r?\n/gu, '\r\n'));
						if (event.type === 'error') write.fire(`${event.message}\r\n`);
					},
				})).then(result => {
					finish(result.status === 'cancelled' ? 130 : result.exitCode ?? 1);
				}, error => { write.fire(`${String(error)}\r\n`); finish(1); });
			},
			close() { controller.abort(); },
		};
	});
}

export function deactivate(): void {}