import { lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { ConfigurationResolverExpression } from './upstream/configurationResolverExpression.js';
import { getNodeValue, parseTree, type Node, type ParseError } from './upstream/json.js';
import { readTaskLabel } from './upstream/taskLabel.js';

export { runProcessTask, type ProcessTaskContext, type ProcessTaskEvent, type ProcessTaskResult } from './process.js';

export interface DiscoveredTaskFile {
  readonly discoveryRoot: string;
  readonly file: string;
}

export interface DiscoveryOptions {
  readonly exclude?: readonly string[];
  readonly useDefaultExclusions?: boolean;
}

export async function discoverTaskFiles(
  roots: readonly string[],
  options: DiscoveryOptions = {},
): Promise<readonly DiscoveredTaskFile[]> {
  const exclusions = new Set([
    ...(options.useDefaultExclusions === false ? [] : ['.git', 'node_modules']),
    ...(options.exclude ?? []),
  ].map(pattern => posix.normalize(pattern.replace(/\\/gu, '/')).replace(/\/$/u, '')));
  const files: DiscoveredTaskFile[] = [];
  for (const root of roots) {
    const discoveryRoot = resolve(root);
    if ((await lstat(discoveryRoot)).isSymbolicLink()) {
      continue;
    }
    async function visit(directory: string): Promise<void> {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((first, second) => first.name < second.name ? -1 : first.name > second.name ? 1 : 0);
      for (const entry of entries) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) {
          const directoryPath = relative(discoveryRoot, file).split(sep).join('/');
          if (!exclusions.has(entry.name) && !exclusions.has(directoryPath)) {
            await visit(file);
          }
        } else if (entry.isFile() && entry.name === 'tasks.json' && basename(directory) === '.vscode') {
          files.push({ discoveryRoot, file });
        }
      }
    }
    await visit(discoveryRoot);
  }
  return files;
}

export interface SourceLocation {
  readonly file: string;
  readonly offset: number;
  readonly length: number;
  readonly line: number;
  readonly column: number;
}

export interface TaskGroupDefinition {
  readonly kind: 'build' | 'test' | 'clean' | 'rebuild';
  readonly isDefault: boolean | string;
}

export interface ParsedTask {
  readonly label: string;
  readonly index: number;
  readonly source: SourceLocation;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly fileConfiguration?: Readonly<Record<string, unknown>>;
  readonly inputDefinitions?: unknown;
  readonly group?: TaskGroupDefinition;
}

export interface ParsedTaskFile {
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly tasks: readonly ParsedTask[];
}

export interface IdentifiedTask extends ParsedTask {
  readonly discoveryRoot: string;
  readonly relativeTaskFile: string;
  readonly canonicalIdentity: string;
  readonly qualifiedSelector: string;
}

export function identifyTask(discoveryRoot: string, task: ParsedTask): IdentifiedTask {
  const root = resolve(discoveryRoot);
  const relativeTaskFile = relative(root, resolve(task.source.file)).split(sep).join('/');
  return {
    ...task,
    discoveryRoot: root,
    relativeTaskFile,
    canonicalIdentity: `vstask:${[root, relativeTaskFile, task.label].map(value => encodeURIComponent(value)).join(':')}`,
    qualifiedSelector: `${relativeTaskFile}#${encodeURIComponent(task.label)}`,
  };
}

export interface PathResolvedTask extends IdentifiedTask {
  readonly taskWorkspaceFolder: string;
  readonly originalCommand?: unknown;
}

export interface TaskPathContext {
  readonly workspaceFolders?: readonly {
    readonly discoveryRoot: string;
    readonly name: string;
    readonly path: string;
  }[];
}

export interface TaskVariableReference {
  readonly id: string;
  readonly name: string;
  readonly arg?: string;
}

export type TaskVariableResolver = (reference: TaskVariableReference, task: IdentifiedTask) => string | undefined;

export interface TaskEditorContext {
  readonly file?: string;
  readonly fileWorkspaceFolder?: string;
  readonly selectedText?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
}

export interface TaskVariableContext extends TaskPathContext {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly configuration?: Readonly<Record<string, unknown>>;
  readonly getConfigurationValue?: (section: string, taskWorkspaceFolder: string) => unknown;
  readonly userHome?: string;
  readonly platform?: NodeJS.Platform;
  readonly editorContext?: TaskEditorContext;
  readonly resolveEditorVariable?: TaskVariableResolver;
  readonly resolveProviderVariable?: TaskVariableResolver;
  readonly resolveHostVariable?: TaskVariableResolver;
}

const editorVariables = new Set([
  'file', 'fileWorkspaceFolder', 'fileWorkspaceFolderBasename', 'relativeFile', 'relativeFileDirname',
  'fileDirname', 'fileExtname', 'fileBasename', 'fileBasenameNoExtension', 'fileDirnameBasename',
  'selectedText', 'lineNumber', 'columnNumber',
]);

function resolveEditorContextVariable(task: IdentifiedTask, context: TaskVariableContext, reference: TaskVariableReference): string {
  const editor = context.editorContext ?? {};
  const paths = (context.platform ?? process.platform) === 'win32' ? win32 : posix;
  const missing = (field: keyof TaskEditorContext) => variableError(task, reference.id,
    `Required editor context ${field} is missing or invalid. Supply --context ${field}=value or --context-file in the CLI; select an active editor value in VS Code.`);
  const text = (field: 'file' | 'fileWorkspaceFolder' | 'selectedText'): string => {
    const value = editor[field];
    if (typeof value !== 'string' || !value) throw missing(field);
    return value;
  };
  if (reference.name === 'selectedText') return text('selectedText');
  if (reference.name === 'lineNumber' || reference.name === 'columnNumber') {
    const value = editor[reference.name];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw missing(reference.name);
    return String(value);
  }
  if (reference.name === 'fileWorkspaceFolder' || reference.name === 'fileWorkspaceFolderBasename') {
    const folder = paths.resolve(text('fileWorkspaceFolder'));
    return reference.name === 'fileWorkspaceFolder' ? folder : paths.basename(folder);
  }
  const file = paths.resolve(text('file'));
  const folder = paths.dirname(file);
  const filename = paths.basename(file);
  switch (reference.name) {
    case 'file': return file;
    case 'fileDirname': return folder;
    case 'fileExtname': return paths.extname(file);
    case 'fileBasename': return filename;
    case 'fileBasenameNoExtension': return filename.slice(0, filename.length - paths.extname(filename).length);
    case 'fileDirnameBasename': return paths.basename(folder);
    case 'relativeFile':
    case 'relativeFileDirname': {
      const workspace = resolveWorkspaceVariable(task, context, 'workspaceFolder', reference.arg);
      const value = paths.relative(workspace, reference.name === 'relativeFile' ? file : folder);
      return reference.name === 'relativeFileDirname' && !value ? '.' : value;
    }
    default: throw variableError(task, reference.id, 'The editor variable is not supported.');
  }
}

export function resolveTaskVariables(task: IdentifiedTask, context: TaskVariableContext = {}): PathResolvedTask {
  const expression = ConfigurationResolverExpression.parse(taskExecution(task, context.platform), context.platform);
  for (const replacement of expression.unresolved()) {
    expression.resolve(replacement, evaluateTaskVariable(task, context, replacement));
  }
  return finishTaskVariables(task, expression, context);
}

function taskExecution(task: IdentifiedTask, platform: NodeJS.Platform = process.platform): Record<string, unknown> {
  const key = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : platform === 'linux' ? 'linux' : '';
  function commandConfiguration(source: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const override = isRecord(source[key]) ? source[key] : {};
    const result = { ...source, ...override };
    if (result.isShellCommand !== undefined) {
      result.type = result.isShellCommand ? 'shell' : 'process';
    }
    if (isRecord(source.options) || isRecord(override.options)) {
      const base = isRecord(source.options) ? source.options : {};
      const extra = isRecord(override.options) ? override.options : {};
      const options = { ...base, ...extra };
      if (typeof extra.cwd !== 'string') {
        if (typeof base.cwd === 'string') options.cwd = base.cwd;
        else delete options.cwd;
      }
      if (isRecord(base.env) && isRecord(extra.env)) {
        options.env = { ...base.env, ...extra.env };
      }
      if (isRecord(base.shell) && isRecord(extra.shell)) {
        options.shell = { ...base.shell, ...extra.shell };
      }
      result.options = options;
    }
    return result;
  }
  const globals = commandConfiguration(task.fileConfiguration ?? {});
  const configuration = commandConfiguration(task.configuration);
  if (configuration.command === undefined && globals.command !== undefined) {
    configuration.command = globals.command;
    configuration.args = [...(Array.isArray(globals.args) ? globals.args : []),
      ...(Array.isArray(configuration.args) ? configuration.args : [])];
  }
  if (isRecord(globals.options)) {
    configuration.options = { ...globals.options, ...(isRecord(configuration.options) ? configuration.options : {}) };
    const options = configuration.options as Record<string, unknown>;
    if (isRecord(globals.options.shell) && isRecord(options.shell)) {
      options.shell = { ...globals.options.shell, ...options.shell };
    }
  }
  configuration.type ??= globals.type ?? (configuration.command !== undefined ? 'process' : undefined);
  return Object.fromEntries(['command', 'args', 'options', 'type']
    .filter(field => Object.hasOwn(configuration, field)).map(field => [field, configuration[field]]));
}

function evaluateTaskVariable(task: IdentifiedTask, context: TaskVariableContext, replacement: TaskVariableReference): string {
  const windows = (context.platform ?? process.platform) === 'win32';
  const environment = Object.fromEntries(Object.entries(context.environment ?? process.env)
    .map(([name, value]) => [windows ? name.toLowerCase() : name, value]));
  const { name, arg, id } = replacement;
  let value: unknown;
  if (name === 'env') {
    if (!arg) {
      throw variableError(task, id, 'No environment name was supplied.');
    }
    value = environment[windows ? arg.toLowerCase() : arg] ?? '';
  } else if (name === 'config') {
    if (!arg) {
      throw variableError(task, id, 'No setting name was supplied.');
    }
    value = context.getConfigurationValue
      ? context.getConfigurationValue(arg, dirname(dirname(resolve(task.source.file))))
      : Object.hasOwn(context.configuration ?? {}, arg) ? context.configuration![arg] : undefined;
    if (value === undefined || value === null) {
      throw variableError(task, id, 'The required setting is not available.');
    }
    if (isRecord(value) && !(value instanceof RegExp) && !(value instanceof Date)) {
      throw variableError(task, id, 'The setting is a structured value.');
    }
  } else if (name === 'userHome') {
    value = context.userHome ?? homedir();
    if (!value) {
      throw variableError(task, id, 'The user home is not available.');
    }
  } else if (name === 'pathSeparator' || name === '/') {
    value = windows ? '\\' : '/';
  } else if (['workspaceFolder', 'workspaceRoot', 'cwd', 'workspaceFolderBasename', 'workspaceRootFolderName'].includes(name)) {
    value = resolveWorkspaceVariable(task, context, name, arg);
  } else if (editorVariables.has(name) && !context.resolveEditorVariable) {
    value = resolveEditorContextVariable(task, context, replacement);
  } else {
    const resolver = editorVariables.has(name) ? context.resolveEditorVariable
      : name === 'execPath' || name === 'execInstallFolder' ? context.resolveHostVariable : context.resolveProviderVariable;
    value = resolver?.(replacement, task);
    if (typeof value !== 'string') {
      throw variableError(task, id, 'A dedicated resolver must supply a string value.');
    }
  }
  return String(value);
}

function finishTaskVariables(task: IdentifiedTask, expression: ConfigurationResolverExpression<Record<string, unknown>>, context: TaskVariableContext): PathResolvedTask {
  const resolved = expression.toObject();
  for (const replacement of ConfigurationResolverExpression.parse(resolved).unresolved()) {
    throw variableError(task, replacement.id, 'The replacement is cyclic or unresolved.');
  }
  return { ...resolveTaskPaths({ ...task, configuration: { ...task.configuration, ...resolved } }, context),
    originalCommand: taskExecution(task, context.platform).command };
}

function variableError(task: IdentifiedTask, variable: string, reason: string): Error {
  return new Error(`${task.source.file}:${task.source.line}:${task.source.column}: Cannot resolve variable ${JSON.stringify(variable)}. ${reason}`);
}

function mapExecutionFields(configuration: Readonly<Record<string, unknown>>, resolveString: (value: string) => string): Record<string, unknown> {
  function resolveValue(value: unknown): unknown {
    if (typeof value === 'string') {
      return resolveString(value);
    }
    if (Array.isArray(value)) {
      return value.map(resolveValue);
    }
    if (isRecord(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveValue(child)]));
    }
    return value;
  }
  const result = { ...configuration };
  for (const field of ['command', 'args', 'options']) {
    if (Object.hasOwn(configuration, field)) {
      result[field] = resolveValue(configuration[field]);
    }
  }
  return result;
}

export function resolveTaskPaths(task: IdentifiedTask, context: TaskPathContext = {}): PathResolvedTask {
  const taskWorkspaceFolder = dirname(dirname(resolve(task.source.file)));
  const configuration = mapExecutionFields(task.configuration, value =>
    value.replace(/\$\{(workspaceFolder|workspaceRoot|cwd|workspaceFolderBasename|workspaceRootFolderName)(?::([^}]*))?\}/gu,
      (_match, variable: string, name: string | undefined) => resolveWorkspaceVariable(task, context, variable, name)));
  const options = isRecord(configuration.options) ? configuration.options : {};
  const cwd = typeof options.cwd === 'string' ? options.cwd : taskWorkspaceFolder;
  configuration.options = {
    ...options,
    cwd: !cwd || isAbsolute(cwd) || cwd.includes('${') ? cwd : join(taskWorkspaceFolder, cwd),
  };
  return { ...task, taskWorkspaceFolder, configuration };
}

function resolveWorkspaceVariable(task: IdentifiedTask, context: TaskPathContext, variable: string, name?: string): string {
  let folder = dirname(dirname(resolve(task.source.file)));
  if (name) {
    const matches = (context.workspaceFolders ?? []).filter(candidate =>
      resolve(candidate.discoveryRoot) === task.discoveryRoot && candidate.name === name);
    if (matches.length !== 1) {
      throw new Error(`${task.source.file}: ${matches.length ? 'Ambiguous' : 'No'} workspace folder ${JSON.stringify(name)} in discovery root ${JSON.stringify(task.discoveryRoot)}.`);
    }
    folder = resolve(task.discoveryRoot, matches[0].path);
  }
  return variable.endsWith('Basename') || variable === 'workspaceRootFolderName' ? basename(folder) : folder;
}

export function selectExactTask(tasks: readonly IdentifiedTask[], selector: string): IdentifiedTask {
  const canonical = tasks.find(task => task.canonicalIdentity === selector);
  if (canonical) {
    return canonical;
  }
  const matches = new Map(tasks
    .filter(task => task.label === selector || task.qualifiedSelector === selector)
    .map(task => [task.canonicalIdentity, task]));
  if (matches.size === 0) {
    throw new Error(`No task matches exact selector ${JSON.stringify(selector)}.`);
  }
  if (matches.size > 1) {
    throw new Error(`Ambiguous exact selector ${JSON.stringify(selector)}. Use one of:\n${[...matches.keys()].join('\n')}`);
  }
  return [...matches.values()][0];
}

export interface NativeTaskPlan {
  readonly task: IdentifiedTask;
  readonly dependsOrder: 'sequence' | 'parallel';
  readonly dependencies: readonly NativeTaskPlan[];
}

export interface VariableResolvedTaskPlan {
  readonly task: PathResolvedTask;
  readonly dependsOrder: 'sequence' | 'parallel';
  readonly dependencies: readonly VariableResolvedTaskPlan[];
}

export type TaskPromptInput = {
  readonly id: string;
  readonly description: string;
  readonly default?: string;
} & ({ readonly type: 'promptString'; readonly password?: boolean }
  | { readonly type: 'pickString'; readonly options: readonly (string | { readonly label?: string; readonly value: string })[] });

type ConfiguredTaskInput = TaskPromptInput | {
  readonly id: string;
  readonly type: 'command';
  readonly command: string;
  readonly args?: unknown;
};

export interface TaskInputContext extends TaskVariableContext {
  readonly inputValues?: Readonly<Record<string, string>>;
  readonly interactive?: boolean;
  readonly promptInput?: (input: TaskPromptInput, task: IdentifiedTask) => Promise<string | undefined>;
  readonly resolveInputCommand?: (command: string, args: unknown, task: IdentifiedTask) => Promise<string | undefined>;
}

function readTaskInput(task: IdentifiedTask, reference: TaskVariableReference): ConfiguredTaskInput {
  const definitions = Array.isArray(task.inputDefinitions) ? task.inputDefinitions : [];
  const input = definitions.filter(candidate => isRecord(candidate) && candidate.id === reference.arg).at(-1);
  if (!reference.arg || !isRecord(input)) {
    throw variableError(task, reference.id, 'The input must be defined in the task file inputs section.');
  }
  if (input.type === 'command') {
    if (typeof input.command !== 'string') {
      throw variableError(task, reference.id, 'The command input definition is not valid.');
    }
    return input as ConfiguredTaskInput;
  }
  if ((input.type !== 'promptString' && input.type !== 'pickString') || typeof input.description !== 'string'
    || (input.default !== undefined && typeof input.default !== 'string')
    || (input.type === 'promptString' && input.password !== undefined && typeof input.password !== 'boolean')
    || (input.type === 'pickString' && (!Array.isArray(input.options) || input.options.some(option =>
      typeof option !== 'string' && (!isRecord(option) || typeof option.value !== 'string'))))) {
    throw variableError(task, reference.id, 'The input definition is not valid.');
  }
  return input as TaskPromptInput;
}

async function resolveTaskInput(task: IdentifiedTask, reference: TaskVariableReference, context: TaskInputContext): Promise<string> {
  const input = readTaskInput(task, reference);
  const qualified = `${task.relativeTaskFile}#${encodeURIComponent(input.id)}`;
  const suppliedKey = [qualified, input.id].find(key => Object.hasOwn(context.inputValues ?? {}, key));
  let value: string | undefined;
  if (suppliedKey !== undefined) {
    value = context.inputValues![suppliedKey];
  } else if (input.type === 'command') {
    if (!context.resolveInputCommand) {
      throw variableError(task, reference.id, 'The required command input resolver is not available.');
    }
    try {
      value = await context.resolveInputCommand(input.command, input.args, task);
    } catch {
      throw variableError(task, reference.id, 'The command input resolver failed.');
    }
    if (typeof value !== 'string') {
      throw variableError(task, reference.id, 'The command input resolver must return a string value.');
    }
  } else if (context.interactive) {
    try {
      value = await context.promptInput?.(input, task);
    } catch {
      throw variableError(task, reference.id, 'Input preparation was canceled or the prompt failed.');
    }
  } else {
    value = input.default;
  }
  if (typeof value !== 'string') {
    throw variableError(task, reference.id, context.interactive
      ? 'Input preparation was canceled or no prompt resolver is available.'
      : 'A required input has no supplied value or configured default.');
  }
  if (input.type === 'pickString' && !input.options.some(option => (typeof option === 'string' ? option : option.value) === value)) {
    throw variableError(task, reference.id, 'The value is not a configured input choice.');
  }
  return value;
}

export async function resolveTaskPlanInputs(plan: NativeTaskPlan, context: TaskInputContext = {}): Promise<VariableResolvedTaskPlan> {
  const resolved = new Map<NativeTaskPlan, VariableResolvedTaskPlan>();
  async function visit(node: NativeTaskPlan): Promise<VariableResolvedTaskPlan> {
    const existing = resolved.get(node);
    if (existing) {
      return existing;
    }
    const expression = ConfigurationResolverExpression.parse(taskExecution(node.task, context.platform), context.platform);
    let hasResolvedInput = false;
    let hasResolvedEditorContext = false;
    let task: PathResolvedTask;
    try {
      for (const reference of expression.unresolved()) {
        const value = reference.name === 'input' ? await resolveTaskInput(node.task, reference, context)
          : evaluateTaskVariable(node.task, context, reference);
        hasResolvedInput ||= reference.name === 'input';
        hasResolvedEditorContext ||= editorVariables.has(reference.name);
        expression.resolve(reference, value);
      }
      task = finishTaskVariables(node.task, expression, context);
    } catch (error) {
      if (hasResolvedInput) {
        throw variableError(node.task, '<resolved value>', 'Input preparation failed. A required value is missing, invalid, or canceled.');
      }
      if (hasResolvedEditorContext) {
        throw variableError(node.task, '<resolved value>', 'Editor context preparation failed. Check --context or --context-file for missing or invalid values.');
      }
      throw error;
    }
    const dependencies: VariableResolvedTaskPlan[] = [];
    for (const dependency of node.dependencies) {
      dependencies.push(await visit(dependency));
    }
    const result = { task, dependsOrder: node.dependsOrder, dependencies };
    resolved.set(node, result);
    return result;
  }
  return visit(plan);
}

export function resolveTaskPlanVariables(plan: NativeTaskPlan, context: TaskVariableContext = {}): VariableResolvedTaskPlan {
  const resolved = new Map<NativeTaskPlan, VariableResolvedTaskPlan>();
  function visit(node: NativeTaskPlan): VariableResolvedTaskPlan {
    const existing = resolved.get(node);
    if (existing) {
      return existing;
    }
    const result = {
      task: resolveTaskVariables(node.task, context),
      dependsOrder: node.dependsOrder,
      dependencies: node.dependencies.map(visit),
    };
    resolved.set(node, result);
    return result;
  }
  return visit(plan);
}

export function planNativeTask(tasks: readonly IdentifiedTask[], selected: IdentifiedTask): NativeTaskPlan {
  const rootTasks = tasks.filter(task => task.discoveryRoot === selected.discoveryRoot);
  const completed = new Map<IdentifiedTask, NativeTaskPlan>();
  const path: IdentifiedTask[] = [];
  function visit(task: IdentifiedTask): NativeTaskPlan {
    const existing = completed.get(task);
    if (existing) {
      return existing;
    }
    const cycleStart = path.indexOf(task);
    if (cycleStart !== -1) {
      const cycle = [...path.slice(cycleStart), task].map(entry => JSON.stringify(entry.label)).join(' -> ');
      throw new Error(`${task.source.file}:${task.source.line}:${task.source.column}: Dependency cycle: ${cycle}.`);
    }
    path.push(task);
    const labels = new Map<string, IdentifiedTask>();
    const identifiers = new Map<string, IdentifiedTask>();
    const localTasks = rootTasks.filter(candidate => candidate.relativeTaskFile === task.relativeTaskFile)
      .sort((first, second) => first.index - second.index);
    for (const candidate of localTasks) {
      labels.set(candidate.label, candidate);
      if (typeof candidate.configuration.identifier === 'string' && candidate.configuration.identifier) {
        identifiers.set(candidate.configuration.identifier, candidate);
      }
    }
    const value = task.configuration.dependsOn;
    const references = value === undefined ? [] : Array.isArray(value) ? value : [value];
    const dependencies = references.map(reference => {
      let target = typeof reference === 'string' ? labels.get(reference) ?? identifiers.get(reference) : undefined;
      if (!target && typeof reference === 'string' && reference.startsWith('ws:')) {
        const selector = reference.slice(3);
        const canonical = rootTasks.filter(candidate => candidate.canonicalIdentity === selector);
        const qualified = canonical.length ? canonical : rootTasks.filter(candidate => candidate.qualifiedSelector === selector);
        const candidates = qualified.length ? qualified : rootTasks.filter(candidate => candidate.label === selector);
        const matches = [...new Map(candidates.sort((first, second) => first.index - second.index)
          .map(candidate => [candidate.canonicalIdentity, candidate])).values()];
        if (matches.length > 1) {
          const suggestions = matches.flatMap(candidate => {
            const alternative = [`ws:${candidate.qualifiedSelector}`, `ws:${candidate.canonicalIdentity}`]
              .find(value => !labels.has(value) && !identifiers.has(value));
            return alternative ? [alternative] : [];
          });
          const collision = suggestions.length < matches.length
            ? ' Some targets have local label or identifier collisions.' : '';
          const guidance = suggestions.length ? ` Use one of:\n${suggestions.join('\n')}` : ' No usable qualified references.';
          throw new Error(`${task.source.file}:${task.source.line}:${task.source.column}: Ambiguous dependency ${JSON.stringify(reference)} for task ${JSON.stringify(task.label)}.${collision}${guidance}`);
        }
        if (matches.length === 1) {
          target = matches[0];
        }
      }
      if (!target) {
        throw new Error(`${task.source.file}:${task.source.line}:${task.source.column}: Missing dependency ${JSON.stringify(reference)} for task ${JSON.stringify(task.label)}.`);
      }
      return visit(target);
    });
    const plan: NativeTaskPlan = { task, dependsOrder: task.configuration.dependsOrder === 'sequence' ? 'sequence' : 'parallel', dependencies };
    path.pop();
    completed.set(task, plan);
    return plan;
  }
  return visit(selected);
}

function sourceLocation(text: string, file: string, offset: number, length: number): SourceLocation {
  const lines = text.slice(0, offset).split(/\r\n|[\r\n\u2028\u2029]/u);
  return { file, offset, length, line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findProperty(node: Node, name: string): Node | undefined {
  return node.children?.filter(property => property.children?.[0].value === name).at(-1);
}

const legacyBuildGroup: TaskGroupDefinition = { kind: 'build', isDefault: false };
const legacyTestGroup: TaskGroupDefinition = { kind: 'test', isDefault: false };

function isBuiltinTask(configuration: Readonly<Record<string, unknown>>): boolean {
  return configuration.customize === undefined && (configuration.type === undefined || configuration.type === null
    || configuration.type === '$customized' || configuration.type === 'process' || configuration.type === 'shell');
}

function readTaskGroup(configuration: Readonly<Record<string, unknown>>): TaskGroupDefinition | undefined {
  const external = configuration.group;
  const kind = typeof external === 'string' ? external : isRecord(external) ? external.kind : undefined;
  if (kind === 'build' || kind === 'test' || kind === 'clean' || kind === 'rebuild') {
    const value = isRecord(external) ? external.isDefault : undefined;
    return { kind, isDefault: typeof value === 'boolean' || typeof value === 'string' ? value : false };
  }
  if (isBuiltinTask(configuration)) {
    if (configuration.isBuildCommand === true) return legacyBuildGroup;
    if (configuration.isTestCommand === true) return legacyTestGroup;
  }
  return undefined;
}

export function parseTaskFile(text: string, file: string): ParsedTaskFile {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors);
  if (errors.length > 0) {
    const source = sourceLocation(text, file, errors[0].offset, errors[0].length);
    throw new Error(`${file}:${source.line}:${source.column}: Invalid JSONC (error ${errors[0].error}).`);
  }
  const configuration: unknown = root && getNodeValue(root);
  if (!isRecord(configuration)) {
    throw new Error(`${file}: Task configuration must be an object.`);
  }
  const taskNodes = findProperty(root, 'tasks')?.children?.[1];
  if (taskNodes && taskNodes.type !== 'array') {
    throw new Error(`${file}: tasks must be an array.`);
  }
  const tasks: ParsedTask[] = [];
  for (const [index, node] of (taskNodes?.children ?? []).entries()) {
    const task: unknown = getNodeValue(node);
    if (!isRecord(task)) {
      throw new Error(`${file}: Task ${index} must be an object.`);
    }
    const label = readTaskLabel(task, configuration.version);
    if (!label) {
      throw new Error(`${file}: Task ${index} must have a label.`);
    }
    const labelName = typeof task.label === 'string' && configuration.version !== '0.1.0' ? 'label' : 'taskName';
    const labelNode = findProperty(node, labelName) ?? node;
    tasks.push({
      label,
      index,
      source: sourceLocation(text, file, labelNode.offset, labelNode.length),
      configuration: task,
      fileConfiguration: configuration,
      group: readTaskGroup(task),
      ...(Object.hasOwn(configuration, 'inputs') ? { inputDefinitions: configuration.inputs } : {}),
    });
  }
  const builtinTasks = tasks.filter(task => isBuiltinTask(task.configuration));
  const legacyBuild = builtinTasks.find(task => task.group === legacyBuildGroup);
  const legacyTest = builtinTasks.find(task => task.group === legacyTestGroup);
  const build = legacyBuild ?? builtinTasks.find(task => task.label === 'build');
  const test = legacyTest ?? builtinTasks.find(task => task.label === 'test');
  if (!legacyBuild && build && build.group?.kind !== 'build') {
    tasks[build.index] = { ...build, group: legacyBuildGroup };
  } else if (!legacyTest && test && test.group?.kind !== 'test') {
    tasks[test.index] = { ...test, group: legacyTestGroup };
  }
  return { configuration, tasks };
}