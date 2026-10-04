import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

type RuntimeFamily = 'Node.js' | 'Bun' | 'Deno';

interface Runtime {
  executable: string;
  family: RuntimeFamily;
  version: string;
}

function probeRuntime(executable: string): Runtime | undefined {
  const probe = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
  if (probe.error || probe.status !== 0) return undefined;
  const match = /^(v|deno )?(\d+)\.(\d+)\.(\d+)(?:\r?\n|$)/u.exec(probe.stdout);
  if (!match) return undefined;
  const family: RuntimeFamily = match[1] === 'v' ? 'Node.js' : match[1] === 'deno ' ? 'Deno' : 'Bun';
  const major = Number(match[2]);
  const minor = Number(match[3]);
  const supported = family === 'Node.js' ? (major === 22 && minor >= 16) || major === 24
    : family === 'Bun' ? major > 1 || (major === 1 && minor >= 2)
    : major > 2 || (major === 2 && minor >= 4);
  return supported ? { executable, family, version: `${match[2]}.${match[3]}.${match[4]}` } : undefined;
}

function pathExecutable(name: string): string | undefined {
  const pathKey = Object.keys(process.env).find(key => process.platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH');
  for (const directory of (process.env[pathKey ?? 'PATH'] ?? '').split(delimiter)) {
    if (!directory) continue;
    const executable = resolve(directory.replace(/^"|"$/gu, ''), process.platform === 'win32' ? `${name}.exe` : name);
    try {
      accessSync(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      if (statSync(executable).isFile()) return executable;
    } catch {}
  }
  return undefined;
}

function selectRuntime(): Runtime | undefined {
  if (process.env.VSTASK_RUNTIME) return probeRuntime(resolve(process.env.VSTASK_RUNTIME));
  for (const [name, family] of [['node', 'Node.js'], ['bun', 'Bun'], ['deno', 'Deno']] as const) {
    const executable = pathExecutable(name);
    const runtime = executable && probeRuntime(executable);
    if (runtime && runtime.family === family) return runtime;
  }
  return undefined;
}

export function launchCli(): void {
  const runtime = selectRuntime();
  if (!runtime) {
    process.stderr.write(`${process.env.VSTASK_RUNTIME ? 'The explicit runtime is missing or unsupported.' : 'No supported runtime is available on PATH.'} Install Node.js 22.16+ or 24 LTS, Bun 1.2+, or Deno 2.4+ (stable releases). See https://nodejs.org/, https://bun.sh/, or https://deno.com/.\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`vstask runtime: ${runtime.family} ${runtime.version} (${runtime.executable})\n`);
  const prefix = runtime.family === 'Deno' ? ['run', '--allow-all', '--no-prompt', '--quiet'] : [];
  const child = spawnSync(runtime.executable, [...prefix, join(__dirname, 'index.js'), ...process.argv.slice(2)], { stdio: 'inherit' });
  if (child.error || child.signal) {
    process.stderr.write(`The selected runtime did not complete (${child.error ? (child.error as NodeJS.ErrnoException).code ?? 'startup error' : child.signal}). No other runtime was started.\n`);
  }
  process.exitCode = child.status ?? 1;
}