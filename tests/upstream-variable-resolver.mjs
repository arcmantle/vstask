import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as paths from 'node:path';
import ts from 'typescript';

export function baselineResolver(folder, configuration, environment, platform = process.platform) {
  const modules = new Map();
  const services = {
    '../../../../base/common/platform.js': {
      isWindows: platform === 'win32', isMacintosh: platform === 'darwin', isLinux: platform === 'linux',
    },
    '../../../../base/common/path.js': platform === 'win32' ? paths.win32 : paths.posix,
    '../../../../base/common/process.js': { cwd: () => folder },
    '../../../../base/common/labels.js': {
      normalizeDriveLetter: value => platform === 'win32' && /^[a-z]:/iu.test(value)
        ? value[0].toUpperCase() + value.slice(1) : value,
    },
    '../../../../base/common/types.js': {
      isString: value => typeof value === 'string',
      isUndefinedOrNull: value => value === undefined || value === null,
      isObject: value => typeof value === 'object' && value !== null && !Array.isArray(value)
        && !(value instanceof RegExp) && !(value instanceof Date),
    },
    '../../../../base/common/iterator.js': {
      Iterable: {
        first: values => values[Symbol.iterator]().next().value,
        empty: function* () {},
        filter: function* (values, predicate) { for (const value of values) { if (predicate(value)) yield value; } },
        map: function* (values, transform) { for (const value of values) yield transform(value); },
      },
    },
    '../../../../base/common/errors.js': { ErrorNoTelemetry: Error },
    '../../../../platform/instantiation/common/instantiation.js': { createDecorator: name => Symbol(name) },
    '../../../../nls.js': { localize: (_key, message, ...args) => message.replace(/\{(\d+)\}/gu, (_match, index) => args[Number(index)]) },
  };
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const source = readFileSync(new URL(`../fixtures/upstream/${name}.ts`, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} };
    modules.set(name, module.exports);
    const require = request => {
      if (Object.hasOwn(services, request)) return services[request];
      if (['./configurationResolver.js', './configurationResolverExpression.js'].includes(request)) {
        return load(request.slice(2, -3));
      }
      throw new Error(`Unsupported upstream probe service: ${request}`);
    };
    new Function('require', 'module', 'exports', code)(require, module, module.exports);
    return module.exports;
  }
  const { AbstractVariableResolverService } = load('variableResolver');
  return new AbstractVariableResolverService({
    getFolderUri: () => undefined,
    getWorkspaceFolderCount: () => 1,
    getConfigurationValue: (_uri, section) => Object.hasOwn(configuration, section) ? configuration[section] : undefined,
  }, undefined, Promise.resolve(homedir()), Promise.resolve(environment));
}