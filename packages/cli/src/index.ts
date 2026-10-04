#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { input, password, select } from '@inquirer/prompts';
import { Builtins, Cli, Command, Option, UsageError, type BaseContext } from 'clipanion';
import Fuse from 'fuse.js';
import { discoverTaskFiles, identifyTask, parseTaskFile, planNativeTask, resolveTaskPlanInputs, runProcessTask, selectExactTask, type IdentifiedTask, type TaskEditorContext, type TaskInputContext, type TaskPromptInput, type VariableResolvedTaskPlan } from '@vstask/core';

export interface CliTaskCandidate {
  readonly task: IdentifiedTask;
  readonly score: number;
}

export function rankCliTasks(tasks: readonly IdentifiedTask[], query: string, threshold = 0.3): readonly CliTaskCandidate[] {
  return findCliTaskCandidates(tasks, query, threshold, false);
}

function findCliTaskCandidates(tasks: readonly IdentifiedTask[], query: string, threshold = 0.3, allowAmbiguousExact = false): readonly CliTaskCandidate[] {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new UsageError('The fuzzy threshold must be a number from 0 to 1.');
  }
  const unique = [...new Map(tasks.map(task => [task.canonicalIdentity, task])).values()];
  const canonical = unique.find(task => task.canonicalIdentity === query);
  if (canonical) return [{ task: canonical, score: 0 }];
  const exact = unique.filter(task => task.label === query || task.qualifiedSelector === query);
  if (exact.length > 0) {
    return allowAmbiguousExact ? exact.map(task => ({ task, score: 0 })) : [{ task: selectExactTask(tasks, query), score: 0 }];
  }
  if (query.trim() === '') return [];
  const search = new Fuse(unique, { keys: ['label', 'qualifiedSelector'], ignoreLocation: true, includeScore: true, threshold });
  return search.search(query).map(result => ({ task: result.item, score: result.score ?? 0 }));
}

export interface CliTaskInputContext extends TaskInputContext {
  readonly inputs?: readonly string[];
}

function parseFuzzyThreshold(value: string | undefined): number | undefined {
  return value === undefined ? undefined : value.trim() === '' ? NaN : Number(value);
}

function cliPromptContext(context: BaseContext, signal: AbortSignal): Parameters<typeof input>[1] {
  return { input: context.stdin, signal, output: new Writable({
    write(chunk, encoding, callback) { context.stderr.write(chunk, encoding, callback); },
  }) };
}

async function readEditorContext(file: string | undefined, entries: readonly string[]): Promise<TaskEditorContext> {
  let values: Record<string, unknown> = {};
  if (file !== undefined) {
    try {
      const parsed: unknown = JSON.parse(await readFile(resolve(file), 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      values = parsed as Record<string, unknown>;
    } catch {
      throw new UsageError('Cannot read editor context. --context-file must refer to a readable JSON object.');
    }
  }
  const fields = ['file', 'fileWorkspaceFolder', 'selectedText', 'lineNumber', 'columnNumber'];
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    const name = entry.slice(0, separator);
    if (separator <= 0 || !fields.includes(name)) {
      throw new UsageError(`Editor context must use name=value. Supported names: ${fields.join(', ')}.`);
    }
    const value = entry.slice(separator + 1);
    values[name] = name === 'lineNumber' || name === 'columnNumber' ? Number(value) : value;
  }
  if (Object.keys(values).some(name => !fields.includes(name))) {
    throw new UsageError(`Unsupported editor context field. Supported names: ${fields.join(', ')}.`);
  }
  return values as TaskEditorContext;
}

export function promptCliInput(
  definition: TaskPromptInput,
  context?: Parameters<typeof input>[1],
): Promise<string> {
  if (definition.type === 'pickString') {
    const choices = definition.options.map(option => typeof option === 'string'
      ? { name: option, value: option }
      : { name: option.label ? `${option.label}: ${option.value}` : option.value, value: option.value });
    const defaults = choices.filter(choice => choice.value === definition.default).reverse();
    return select({ message: definition.description,
      choices: [...defaults, ...choices.filter(choice => choice.value !== definition.default)],
      default: definition.default }, context);
  }
  const config = { message: definition.description, default: definition.default };
  return definition.password
    ? password({ message: definition.description, mask: true }, context).then(value => value || definition.default || '')
    : input(config, context);
}

export async function resolveCliTaskPlan(
  tasks: readonly IdentifiedTask[],
  selected: IdentifiedTask,
  context: CliTaskInputContext = {},
): Promise<VariableResolvedTaskPlan> {
  const entries = (context.inputs ?? []).map(entry => {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      throw new UsageError('A supplied input must use id=value.');
    }
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  });
  const inputValues = Object.fromEntries([...Object.entries(context.inputValues ?? {}), ...entries]);
  return resolveTaskPlanInputs(planNativeTask(tasks, selected), {
    ...context, inputValues,
    interactive: context.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    promptInput: context.promptInput ?? (definition => promptCliInput(definition)),
  });
}

abstract class TaskCommand extends Command {
  workspaces = Option.Array('--workspace', [], { description: 'Search a discovery root. Repeat for more roots.' });
  exclude = Option.Array('--exclude', [], { description: 'Exclude a directory name or relative path. Repeat for more exclusions.' });
  defaultExcludes = Option.Boolean('--default-excludes', true, { description: 'Exclude .git and node_modules. Use --no-default-excludes to disable.' });
  taskFile = Option.String('--file', { description: 'Read one task file instead of searching discovery roots.' });
  selector: string | undefined;

  async execute(): Promise<number> {
    try {
      if (this.taskFile !== undefined && (this.workspaces.length > 0 || this.exclude.length > 0 || !this.defaultExcludes)) {
        throw new UsageError('--file cannot be combined with discovery options.');
      }
      const files = this.taskFile !== undefined
        ? [{ file: resolve(this.taskFile), discoveryRoot: dirname(dirname(resolve(this.taskFile))) }]
        : await discoverTaskFiles(this.workspaces.length ? this.workspaces : [process.cwd()], {
          exclude: this.exclude,
          useDefaultExclusions: this.defaultExcludes,
        });
      const tasks: IdentifiedTask[] = [];
      for (const { file, discoveryRoot } of files) {
        const parsed = parseTaskFile(await readFile(file, 'utf8'), file);
        for (const task of parsed.tasks) {
          tasks.push(identifyTask(discoveryRoot, task));
        }
      }
      return await this.executeTasks(tasks);
    } catch (error) {
      this.context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  protected async executeTasks(tasks: readonly IdentifiedTask[]): Promise<number> {
    const selected = this.selectTasks(tasks);
    for (const task of selected) {
      this.context.stdout.write(`${task.label}\t${task.source.file}:${task.source.line}:${task.source.column}\t${task.canonicalIdentity}\t${task.qualifiedSelector}\n`);
    }
    return 0;
  }

  protected selectTasks(tasks: readonly IdentifiedTask[]): readonly IdentifiedTask[] {
    return this.selector === undefined ? tasks : [selectExactTask(tasks, this.selector)];
  }
}

class ListCommand extends TaskCommand {
  static paths = [['list']];
  static usage = Command.Usage({ description: 'List discovered tasks and their exact selectors.' });
}

class SelectCommand extends TaskCommand {
  static paths = [['select']];
  static usage = Command.Usage({ description: 'Select an exact task or list fuzzy candidates without execution.' });
  selector = Option.String({ name: 'selector' });
  fuzzy = Option.Boolean('--fuzzy', false, { description: 'List ranked partial-name and typing-error candidates. Exact selectors take priority.' });
  threshold = Option.String('--threshold', { description: 'Set the fuzzy threshold from 0 to 1 (default: 0.3). Requires --fuzzy.' });

  protected selectTasks(tasks: readonly IdentifiedTask[]): readonly IdentifiedTask[] {
    if (!this.fuzzy) {
      if (this.threshold !== undefined) throw new UsageError('--threshold requires --fuzzy.');
      return super.selectTasks(tasks);
    }
    const candidates = rankCliTasks(tasks, this.selector, parseFuzzyThreshold(this.threshold));
    if (candidates.length === 0) throw new UsageError(`No task matches fuzzy query ${JSON.stringify(this.selector)}.`);
    return candidates.map(candidate => candidate.task);
  }
}

class RunCommand extends TaskCommand {
  static paths = [['run']];
  static usage = Command.Usage({ description: 'Select and run one process or shell task.' });
  selector = Option.String({ name: 'selector' });
  fuzzy = Option.Boolean('--fuzzy', false, { description: 'Permit partial-name and typing-error selection in non-interactive runs.' });
  threshold = Option.String('--threshold', { description: 'Set the fuzzy threshold from 0 to 1 (default: 0.3).' });
  inputs = Option.Array('--input', [], { description: 'Supply an input as id=value. Repeat for more inputs.' });
  editorContext = Option.Array('--context', [], { description: 'Supply editor context as name=value. Repeat for more values.' });
  contextFile = Option.String('--context-file', { description: 'Read supplied editor context from a JSON object.' });

  protected async executeTasks(tasks: readonly IdentifiedTask[]): Promise<number> {
    const controller = new AbortController();
    let cancellationCode = 130;
    const interrupt = () => { if (!controller.signal.aborted) { cancellationCode = 130; controller.abort(); } };
    const terminate = () => { if (!controller.signal.aborted) { cancellationCode = 143; controller.abort(); } };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    try {
      const interactive = Boolean('isTTY' in this.context.stdin && this.context.stdin.isTTY
        && 'isTTY' in this.context.stdout && this.context.stdout.isTTY);
      if (!interactive && !this.fuzzy && this.threshold !== undefined) throw new UsageError('--threshold requires --fuzzy.');
      const candidates = this.fuzzy || interactive ? findCliTaskCandidates(tasks, this.selector, parseFuzzyThreshold(this.threshold), interactive)
        : [{ task: selectExactTask(tasks, this.selector), score: 0 }];
      if (candidates.length === 0 || (!interactive && candidates.length > 1)) {
        throw new UsageError(candidates.length === 0 ? `No task matches fuzzy query ${JSON.stringify(this.selector)}.`
          : `Ambiguous task selection:\n${candidates.map(candidate => candidate.task.canonicalIdentity).join('\n')}`);
      }
      const identity = candidates.length === 1 ? candidates[0].task.canonicalIdentity : await select({
        message: 'Select a task',
        choices: candidates.map(({ task }) => ({ name: `${task.label} (${task.canonicalIdentity})`, value: task.canonicalIdentity })),
      }, cliPromptContext(this.context, controller.signal));
      const selected = selectExactTask(tasks, identity);
      if (interactive && ![selected.label, selected.qualifiedSelector, selected.canonicalIdentity].includes(this.selector)) {
        this.context.stderr.write(`Selected task: ${selected.label} (${selected.canonicalIdentity})\n`);
      }
      const editorContext = await readEditorContext(this.contextFile, this.editorContext);
      const plan = await resolveCliTaskPlan(tasks, selected, { inputs: this.inputs, editorContext, interactive,
        promptInput: definition => promptCliInput(definition, cliPromptContext(this.context, controller.signal)) });
      if (plan.dependencies.length > 0) {
        throw new UsageError('Dependency execution is not available in this stage.');
      }
      const result = await runProcessTask(plan.task, {
        stdin: this.context.stdin, signal: controller.signal,
        onEvent: event => {
          if (event.type === 'output') {
            this.context[event.stream].write(event.data);
          } else if (event.type === 'error') {
            this.context.stderr.write(`${event.message}\n`);
          }
        },
      });
      if (result.status === 'cancelled') {
        this.context.stderr.write('Task cancelled.\n');
        return cancellationCode;
      }
      return result.exitCode ?? 1;
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    }
  }
}

export async function runCli(args: string[], context: Partial<BaseContext> = {}): Promise<number> {
  const cli = new Cli({ binaryName: 'vstask' });
  cli.register(ListCommand);
  cli.register(SelectCommand);
  cli.register(RunCommand);
  cli.register(Builtins.HelpCommand);
  try {
    const command = cli.process(args, context);
    return await cli.run(command, context);
  } catch (error) {
    (context.stderr ?? process.stderr).write(cli.error(error, { colored: false }));
    return 1;
  }
}

if (require.main === module) {
  void runCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}