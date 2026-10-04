import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { PathResolvedTask } from './index.js';
import { shellLaunch } from './shell.js';

export interface ProcessTaskResult {
  readonly status: 'success' | 'failed' | 'cancelled';
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: string;
}

export type ProcessTaskEvent = { readonly taskIdentity: string } & (
  | { readonly type: 'start'; readonly pid: number }
  | { readonly type: 'output'; readonly stream: 'stdout' | 'stderr'; readonly data: Uint8Array }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'complete'; readonly result: ProcessTaskResult }
);

export interface ProcessTaskContext {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly userHome?: string;
  readonly stdin?: Readable;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ProcessTaskEvent) => void;
}

export function runProcessTask(task: PathResolvedTask, context: ProcessTaskContext = {}): Promise<ProcessTaskResult> {
  if (context.signal?.aborted) {
    const result: ProcessTaskResult = { status: 'cancelled', exitCode: null, signal: null };
    context.onEvent?.({ type: 'complete', taskIdentity: task.canonicalIdentity, result });
    return Promise.resolve(result);
  }
  const location = `${task.source.file}:${task.source.line}:${task.source.column}`;
  const configuration = task.configuration;
  function argument(value: unknown): string {
    const raw = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as { value?: unknown }).value : value;
    const literal = Array.isArray(raw) && raw.every(entry => typeof entry === 'string') ? raw.join(' ') : raw;
    if (typeof literal !== 'string' || literal.includes('\0')) {
      throw new Error(`${location}: A process command or argument must be a string without null characters.`);
    }
    return literal;
  }
  if (configuration.type !== 'process' && configuration.type !== 'shell') {
    throw new Error(`${location}: Only process and shell tasks can run in this stage.`);
  }
  if (configuration.isBackground === true) {
    throw new Error(`${location}: Background execution is not available in this stage.`);
  }
  const command = configuration.type === 'shell' ? '' : argument(configuration.command);
  if (!command && configuration.type !== 'shell') {
    throw new Error(`${location}: A process command must not be empty.`);
  }
  if (configuration.args !== undefined && !Array.isArray(configuration.args)) {
    throw new Error(`${location}: Process arguments must be an array.`);
  }
  const args = configuration.type === 'shell' ? [] : ((configuration.args ?? []) as unknown[]).map(argument);
  const options = configuration.options as { cwd?: string; env?: Record<string, unknown> };
  const taskEnvironment: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env ?? {})) {
    try {
      if (value === null || value === undefined || key.includes('\0') || key.includes('=')) {
        throw new Error();
      }
      taskEnvironment[key] = String(value);
      if (taskEnvironment[key].includes('\0')) {
        throw new Error();
      }
    } catch {
      throw new Error(`${location}: A process environment value is not valid.`);
    }
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries({ ...(context.environment ?? process.env), ...taskEnvironment })) {
    if ((context.platform ?? process.platform) === 'win32') {
      for (const existing of Object.keys(environment)) {
        if (existing.toLowerCase() === key.toLowerCase()) {
          delete environment[existing];
        }
      }
    }
    environment[key] = value;
  }
  const cwd = options.cwd || context.userHome || homedir();
  const launch = configuration.type === 'shell'
    ? shellLaunch(configuration, context.platform ?? process.platform, environment, location, task.originalCommand, cwd)
    : { command, args, windowsVerbatimArguments: false };
  const emit = (event: ProcessTaskEvent) => context.onEvent?.(event);
  const taskIdentity = task.canonicalIdentity;
  return new Promise(resolve => {
    let startupError: string | undefined;
    let cleanupError: string | undefined;
    let cancelled = false;
    let cleanup: Promise<void> | undefined;
    function fail(error: unknown): void {
      const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      startupError = `${location}: Cannot start process (${code}).`;
      emit({ type: 'error', taskIdentity, message: startupError });
    }
    function complete(exitCode: number | null, signal: NodeJS.Signals | null): void {
      const result: ProcessTaskResult = {
        status: cancelled ? 'cancelled' : startupError ? 'failed' : exitCode === 0 && signal === null ? 'success' : 'failed',
        exitCode: startupError === undefined && !cancelled ? exitCode : null, signal,
        ...(cleanupError || startupError ? { error: cleanupError ?? startupError } : {}),
      };
      emit({ type: 'complete', taskIdentity, result });
      resolve(result);
    }
    try {
      const child = spawn(launch.command, launch.args, {
        cwd, env: environment, shell: false,
        detached: process.platform !== 'win32',
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        cleanup = child.pid === undefined ? Promise.resolve() : stopOwnedProcessTree(child.pid).catch(() => {
          cleanupError = `${location}: Cannot stop owned processes.`;
          emit({ type: 'error', taskIdentity, message: cleanupError });
        });
      };
      context.signal?.addEventListener('abort', cancel, { once: true });
      if (context.signal?.aborted) cancel();
      child.once('spawn', () => emit({ type: 'start', taskIdentity, pid: child.pid! }));
      child.stdout.on('data', (data: Buffer) => emit({ type: 'output', taskIdentity, stream: 'stdout', data }));
      child.stderr.on('data', (data: Buffer) => emit({ type: 'output', taskIdentity, stream: 'stderr', data }));
      child.once('error', fail);
      child.stdin.on('error', () => {});
      if (context.stdin) {
        context.stdin.pipe(child.stdin);
      } else {
        child.stdin.end();
      }
      child.once('close', async (exitCode, signal) => {
        context.signal?.removeEventListener('abort', cancel);
        context.stdin?.unpipe(child.stdin);
        context.stdin?.pause();
        await cleanup;
        complete(exitCode, signal);
      });
    } catch (error) {
      fail(error);
      complete(null, null);
    }
  });
}

async function stopOwnedProcessTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    let descendants = [pid];
    let failure: unknown;
    try {
      const { default: pidtree } = await import('pidtree');
      descendants = await pidtree(pid, { root: true });
    } catch (error) { failure = error; }
    for (const owned of [-pid, ...descendants.reverse()]) {
      try { signalOwnedProcess(owned, 'SIGKILL'); }
      catch (error) { failure ??= error; }
    }
    const deadline = Date.now() + 2000;
    while (descendants.some(owned => signalOwnedProcess(owned, 0))) {
      if (Date.now() >= deadline) throw new Error('Owned processes did not stop.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (failure) throw failure;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const command = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    const killer = spawn(command, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', reject);
    killer.once('close', code => code === 0 ? resolve() : reject(new Error('Owned process cleanup failed.')));
  });
}

function signalOwnedProcess(pid: number, signal: NodeJS.Signals | 0): boolean {
  try { process.kill(pid, signal); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; return false; }
}