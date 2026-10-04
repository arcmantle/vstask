/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See upstream/LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import { posix, win32 } from 'node:path';

interface Quoting {
  strong?: string;
  weak?: string;
  escape?: string | { escapeChar: string; charsToEscape: string };
}

export function shellLaunch(
  configuration: Readonly<Record<string, unknown>>,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  location: string,
  originalCommand: unknown = configuration.command,
  cwd?: string,
): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  function literal(value: unknown): string {
    const raw = Array.isArray(value) && value.every(entry => typeof entry === 'string') ? value.join(' ') : value;
    if (typeof raw !== 'string' || raw.includes('\0')) {
      throw new Error(`${location}: A shell command or argument must be a string without null characters.`);
    }
    return raw;
  }
  const options = configuration.options as { shell?: { executable?: string; args?: string[]; quoting?: Quoting } };
  const shell = options.shell;
  const command = literal(shell?.executable ?? (platform === 'win32' ? 'powershell.exe' : environment.SHELL || '/bin/sh'));
  if (!command) throw new Error(`${location}: A shell executable must not be empty.`);
  const basename = (platform === 'win32' ? win32 : posix).parse(command).name.toLowerCase();
  if (platform === 'win32' && basename === 'cmd' && cwd?.startsWith('\\\\')) {
    throw new Error(`${location}: cmd cannot execute a task in a UNC working directory.`);
  }
  const posixQuotes: Quoting = { strong: "'", weak: '"', escape: { escapeChar: '\\', charsToEscape: ' "\'' } };
  const powershellQuotes: Quoting = { strong: "'", weak: '"', escape: { escapeChar: '`', charsToEscape: ' "\'()' } };
  const quoting = shell?.quoting ?? (basename === 'cmd' ? { strong: '"' }
    : basename === 'powershell' || basename === 'pwsh' ? powershellQuotes
      : basename === 'bash' || basename === 'zsh' || platform !== 'win32' ? posixQuotes : powershellQuotes);
  function needsQuotes(value: string): boolean {
    if (value.length >= 2 && (value[0] === quoting.strong || value[0] === quoting.weak) && value[0] === value.at(-1)) return false;
    let activeQuote: string | undefined;
    for (let index = 0; index < value.length; index++) {
      const character = value[index];
      if (character === activeQuote) activeQuote = undefined;
      else if (activeQuote !== undefined) continue;
      else if (character === quoting.escape) index++;
      else if (character === quoting.strong || character === quoting.weak) activeQuote = character;
      else if (character === ' ') return true;
    }
    return false;
  }
  function quote(value: unknown): [string, boolean] {
    const object = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as { value?: unknown; quoting?: string } : undefined;
    const text = literal(object ? object.value : value);
    const kind = object ? object.quoting ?? 'strong' : needsQuotes(text) ? 'strong' : undefined;
    if (kind === 'strong' && quoting.strong) return [quoting.strong + text + quoting.strong, true];
    if (kind === 'weak' && quoting.weak) return [quoting.weak + text + quoting.weak, true];
    if (kind === 'escape' && quoting.escape) {
      const escape = quoting.escape;
      if (typeof escape === 'string') return [text.replace(/ /g, escape + ' '), true];
      const pattern = new RegExp('[' + [...escape.charsToEscape].map(character => `\\${character}`).join(',') + ']', 'g');
      return [text.replace(pattern, match => escape.escapeChar + match), true];
    }
    return [text, false];
  }
  if (configuration.args !== undefined && !Array.isArray(configuration.args)) {
    throw new Error(`${location}: Shell arguments must be an array.`);
  }
  const values = ((configuration.args as unknown[] | undefined) ?? []).filter(value => {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return literal((value as { value?: unknown }).value) !== '';
    }
    return true;
  });
  const commandValue = Array.isArray(configuration.command) ? literal(configuration.command) : configuration.command;
  const originalValue = Array.isArray(originalCommand) ? literal(originalCommand) : originalCommand;
  const [quotedCommand, commandQuoted] = quote(commandValue);
  if (!quotedCommand) throw new Error(`${location}: A shell command must not be empty.`);
  const quotedArgs = values.map(quote);
  const commandOnly = typeof commandValue === 'string' && values.length === 0
    && (commandValue === originalValue || typeof originalValue === 'string' && needsQuotes(originalValue));
  let commandLine = commandOnly ? commandValue : [quotedCommand, ...quotedArgs.map(([value]) => value)].join(' ');
  if (platform === 'win32' && !commandOnly) {
    if (basename === 'cmd' && commandQuoted && quotedArgs.some(([, quoted]) => quoted)) commandLine = '"' + commandLine + '"';
    else if ((basename === 'powershell' || basename === 'pwsh') && commandQuoted) commandLine = '& ' + commandLine;
  }
  if (shell?.args !== undefined && !Array.isArray(shell.args)) throw new Error(`${location}: Shell arguments must be an array.`);
  const args = (shell?.args ?? []).map(literal);
  if (!shell?.executable) {
    const switches = platform !== 'win32' || ['bash', 'zsh', 'nu'].includes(basename) ? ['-c']
      : ['powershell', 'pwsh'].includes(basename) ? ['-Command'] : basename === 'wsl' ? ['-e'] : ['/d', '/c'];
    for (const option of switches) {
      if (!args.some((argument, index) => argument.toLowerCase() === option.toLowerCase()
        && args.slice(index + 1).every(next => next.startsWith('-')))) args.push(option);
    }
  }
  args.push(commandLine);
  return { command, args, windowsVerbatimArguments: platform === 'win32' && !['bash', 'zsh'].includes(basename) };
}