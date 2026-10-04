# VS Code Baseline

## Recorded Baseline

- Repository: https://github.com/microsoft/vscode
- Stable tag: `1.105.1`
- Commit: `7d842fb85a0275a4a8e4d7e040d2625abbf7f084`
- Initial issue: `ISS_6JV5JYJ27P8PJ8KEDWC291ZCF7`
- Architecture decision: `ADR_04MWY8B6HW8NYRAS77KHRPJ899`

This is an initial stable baseline, not a claim to support the latest VS Code release.
The package version is `0.0.0`. This stage is not release-ready.

## Imported Files

[baseline.json](baseline.json) records each upstream path, local path, and Git blob hash.
The initial download was checked against the repository tree at the pinned commit.
`npm run verify` checks the local Git blob hashes without a network connection.

The compiled JSONC parser is [json.ts](packages/core/src/upstream/json.ts).
It is unchanged from upstream. It supplies parsing, comment and trailing-comma support,
and syntax-tree offsets. The wrapper uses the tree to keep source locations.

[taskLabel.ts](packages/core/src/upstream/taskLabel.ts) adapts the label-selection block
from `CustomTask.from` in the pinned task configuration parser.
It keeps `taskName` for version `0.1.0` and gives a string `label` priority for version `2.0.0`.
Like upstream, an absent or unrecognized version uses the version `2.0.0` label rule.
The adaptation uses `typeof` instead of `Types.isString` and returns a label without workbench services.
This block does not implement the complete upstream task configuration parser.

The files in [fixtures/upstream/taskConfiguration.ts](fixtures/upstream/taskConfiguration.ts)
and the other reference entries in the manifest are unchanged reference snapshots.
They are not compiled or imported at runtime. They define the field inventory and future compatibility checks.
Do not replace unavailable workbench services with empty implementations to claim task compatibility.

## License Notices

The imported files keep their upstream copyright and MIT license headers.
The complete upstream license is [LICENSE.txt](packages/core/src/upstream/LICENSE.txt).
The extracted label block keeps its upstream notice.
The core package includes the license in its package file list.
Any future bundle or release artifact that includes this code must include the notice and license.
This record does not assign a license to the rest of the project.

## Current Contract

`parseTaskFile(text, file)` returns task labels, zero-based task indices,
one-based source lines and columns, character offsets, and unresolved configuration objects.
Locations refer to the effective label property key. Duplicate properties use the last value.
This model preserves task-file data. It is not an execution-ready normalized task model.

`resolveTaskPaths(identifiedTask, context?)` returns a copy with `taskWorkspaceFolder`
and resolved workspace paths in `command`, `args`, and `options`. The task workspace
folder is the parent of the source file's `.vscode` folder, not the discovery root.
The resolver preserves canonical identity, source location, literal labels, dependency
references, and the original parsed configuration.

The supported path variables are `workspaceFolder`, `workspaceRoot`, `cwd`,
`workspaceFolderBasename`, and `workspaceRootFolderName`. Named forms use
`context.workspaceFolders`, whose entries have `discoveryRoot`, `name`, and `path`.
Lookup is exact and limited to the source discovery root. Missing or duplicate names
produce an error. Relative context paths are relative to their discovery root.

The resolver supplies the task workspace folder when `options.cwd` is absent or
not a string. It joins a relative cwd to that folder and preserves absolute or empty
values. Other variables remain unresolved; a cwd with an unresolved variable remains
unchanged until its value is available. Callers must apply global inheritance and
platform overrides before this step. Matcher paths and editor-dependent variables
belong to their later resolution stages.

Moving a task file from a root `.vscode` folder to `project/.vscode` changes its
workspace-folder variables and relative cwd base to `project`. Check relative paths
after such a move. Absolute paths do not depend on this base.
The [workspace path matrix](fixtures/workspace-paths.json) records the pinned variable
and cwd rules. Public core tests also check named references and discovery-root isolation.
These checks do not prove adapter execution or Windows integration.

### VS Code Leaf Execution

`npm run test:extension` starts a VS Code 1.105.1 extension host. The provider
discovers leaf tasks under open workspace folders and publishes canonical identities
through the standard task interface. Simple process and shell commands use native
execution. Structured command values, custom shell quoting, and variable-dependent
tasks use the shared executor through `CustomExecution`. Variable resolution for
these tasks starts only when the task runs, not during discovery.

The host test compares native process, native shell, and custom shell probe output
and exit status with the CLI. It checks integrated terminals, nested discovery,
unselected inputs, and unchanged task files. Run this check on macOS and Windows;
one platform does not prove the other platform's behavior.

This is a leaf execution stage, not full adapter compatibility. Compound tasks,
background readiness, problem reporting, terminal presentation, provider-backed
values, refresh, run options, and owned-process cancellation have separate issues.

### Task Groups

`ParsedTask.group` contains a normalized `kind` and boolean or string `isDefault`.
The original configuration remains unchanged. The pinned `GroupKind.from`,
`CustomTask.from`, and `TaskConfig.from` define valid group IDs, legacy flag fallback,
and per-file label inference. Legacy flags take priority over inferred labels.
The pinned inference uses a build-first `else if`: when both labels need inference
in one file, only build receives an inferred group in that pass.

The pinned
[task service](https://github.com/microsoft/vscode/blob/7d842fb85a0275a4a8e4d7e040d2625abbf7f084/src/vs/workbench/contrib/tasks/browser/abstractTaskService.ts)
defines pattern matching and default priority in `_getGlobTasks`,
`_getDefaultTasks`, and `_runTaskGroupCommand`. This source was inspected, not imported.
The extension maps patterns to public boolean default flags on each task request.
It uses the public document matcher with a workspace-relative pattern. Matching
patterns suppress boolean defaults only in the same group. Multiple matches retain
separate defaults. No private API or shared task-group constant is changed.

Two core contracts verify definitions, preserved metadata, and inference priority.
One pinned-host group contract verifies standard build/test commands, native/custom
defaults, exact duplicate-label selection, pattern priority, editor changes, boolean
fallback, multiple matches, and unchanged task files. These checks pass on macOS.
Windows verification remains pending.

### Built-in Variable Resolution

`resolveTaskVariables(task, context?)` resolves execution fields in a copy.
`resolveTaskPlanVariables(plan, context?)` resolves only the selected graph and keeps
shared dependency nodes shared. Labels, dependency references, source locations,
canonical identities, and unselected tasks are not evaluated or changed.

The execution fields are `command`, `args`, and `options`, including quoted values,
shell fields, environment values, and object keys. Variable preparation now applies
file-level command inheritance and active platform overrides before resolution.
The path-only resolver still requires effective configuration from its caller.
Relative cwd values are joined to the task
workspace folder after substitution. Matcher paths belong to the matcher stage.

The compiled expression parser is adapted from the pinned
[configurationResolverExpression.ts](fixtures/upstream/configurationResolverExpression.ts).
The manifest records its dependency changes. It keeps upstream nested replacement,
key-renaming, replacement reuse, and recursion tracking. Its upstream license notice
is retained. The unchanged
[variableResolver.ts](fixtures/upstream/variableResolver.ts) defines value evaluation.

| Variable Group | Variables | Resolution Contract |
| --- | --- | --- |
| Workspace | `workspaceFolder`, `workspaceRoot`, `cwd`, `workspaceFolderBasename`, `workspaceRootFolderName` | Use the task workspace folder. Named forms use the existing same-root folder context. |
| Environment | `env` | Use `context.environment` or the process environment, not sibling task overrides. Windows names are case-insensitive. An absent named value becomes an empty string. An absent name is an error. |
| Configuration | `config` | Use exact keys in `context.configuration`, or `getConfigurationValue(section, taskWorkspaceFolder)` when supplied. The callback takes priority. Missing, null, and object settings are errors. Scalar values and arrays use the pinned string conversion. |
| Host-independent | `userHome`, `pathSeparator`, `/` | Use the host home and platform separator, or explicit context values. An empty home is an error. |
| Editor | `file`, `fileWorkspaceFolder`, `fileWorkspaceFolderBasename`, `relativeFile`, `relativeFileDirname`, `fileDirname`, `fileExtname`, `fileBasename`, `fileBasenameNoExtension`, `fileDirnameBasename`, `selectedText`, `lineNumber`, `columnNumber` | Route to `resolveEditorVariable`. Editor-context resolution is a separate issue. |
| Application Host | `execPath`, `execInstallFolder` | Route to `resolveHostVariable`. Do not substitute the CLI runtime path for the VS Code executable path. |
| Provider | `command`, `input`, `extensionInstallFolder`, `defaultBuildTask`, contributed names | Route to `resolveProviderVariable`. Input and installed-provider integration are separate issues. |

Dedicated callbacks receive the variable reference and source task. They return
a string, including an empty string when their contract permits it, or `undefined`
when the value is not available. An `undefined` result is an error. Missing resolvers,
unavailable required values, and unresolved cycles fail with source locations before a
plan is returned. This required-value check is stricter than upstream preservation of
unknown or unresolved variable text. Error messages do not include setting values.

The adapter preparation APIs are `resolveCliTaskPlan(tasks, selected, context?)` and
`resolveVSCodeTaskPlan(tasks, selected, context?)`. They validate dependencies and use
the same asynchronous core input resolver. Await their results before task startup.
They return values in memory and do not log them or start tasks.
The CLI module can be imported without starting its command handler. The existing CLI
listing and selection commands remain unchanged. Preparation does not start a process
or register a VS Code task provider. The separate process API is described below.

The public tests compare both adapter preparation results with the unchanged pinned
evaluator, using controlled host and setting inputs. They also compare Windows and
POSIX environment lookup. The test reference loads the recorded sources and rejects
unsupported services. These tests verify substitution, not complete workbench execution.
Actual VS Code execution and Windows integration remain pending release gates.

### Input Evaluation

The pinned
[BaseConfigurationResolverService](https://github.com/microsoft/vscode/blob/7d842fb85a0275a4a8e4d7e040d2625abbf7f084/src/vs/workbench/services/configurationResolver/browser/baseConfigurationResolverService.ts)
defines interactive input evaluation in `resolveWithInteraction` and `showUserInput`.
This source was inspected; it is not an additional imported file.

`resolveTaskPlanInputs(plan, context?)` uses the existing pinned expression parser
and the shared built-in variable evaluator. It retains replacement order, nested
substitution, key substitution, repeated-reference reuse, and cycle checks.
Input lookup is source-file-scoped and uses the last matching definition.
Choice labels display their stored values, and configured defaults appear first.
Command arguments are passed unchanged to an explicit callback. Cancellation and
unavailable or non-string values stop preparation before any task can start.

The approved non-interactive contract adds supplied input values and configured
default fallback without prompts. File-qualified values take priority over bare IDs.
No value is logged during preparation. The CLI uses Inquirer for interactive
controls; VS Code prompt and command-provider integration remain separate work.
The [input preparation contract](README.md#input-preparation) records the public
syntax and the five public-interface keeper tests cover this stage.

### Native Dependency Graph

`planNativeTask(tasks, selectedTask)` validates and returns a graph for string references
in one task file and discovery root. It preserves task configuration and source metadata.
The public fixtures in [model.test.mjs](tests/model.test.mjs) check local scope,
order defaults, shared-node reuse, identifier aliases, duplicate labels, missing targets,
and direct or indirect cycles. Invalid unselected graphs do not block the selected plan.

The pinned `TaskDependency.from` and `DependsOrder.from` blocks define string references
and the sequence/parallel default. The pinned
[AbstractTaskService resolver](https://github.com/microsoft/vscode/blob/7d842fb85a0275a4a8e4d7e040d2625abbf7f084/src/vs/workbench/contrib/tasks/browser/abstractTaskService.ts#L2002)
with a complete task list uses label lookup before identifier lookup. Its maps retain
the last duplicate. Core uses task-file indices to retain this order.

The pinned
[TerminalTaskSystem executor](https://github.com/microsoft/vscode/blob/7d842fb85a0275a4a8e4d7e040d2625abbf7f084/src/vs/workbench/contrib/tasks/browser/terminalTaskSystem.ts#L515)
uses `encounteredTasks` to reuse dependency results within a run. The graph preserves
declared edges and shares nodes rather than copying a task for each edge.
Sequence order applies to dependencies, not to the entire graph.

The issue contract requires missing targets and cycles to fail before startup.
Core therefore rejects them before returning a graph rather than copying upstream
runtime logging and cycle handling. Task-definition object references, extended lookup,
active-task attachment, readiness, failure, cancellation, and adapter execution are not
verified by this stage. They remain in the fixture inventory.

### Process Startup

`runProcessTask` starts a prepared process task with `shell: false`. It forwards
stdin, keeps stdout and stderr separate, and reports startup, raw output, startup
errors, and one final result after stream closure. CLI `run` uses exact selection
and shared preparation. The extension package does not provide tasks yet.

The pinned `CommandConfiguration.from`, `assignProperties`, and `fillGlobals`
blocks define platform command replacement and file-level argument inheritance.
`CommandOptions.assignProperties` merges platform environment entries.
`CommandOptions.fillProperties` fills absent cwd and env properties from globals;
it does not merge global env entries into an existing task env object.
The raw file configuration is retained on parsed tasks for these defaults.

The pinned
[TerminalTaskSystem](https://github.com/microsoft/vscode/blob/7d842fb85a0275a4a8e4d7e040d2625abbf7f084/src/vs/workbench/contrib/tasks/browser/terminalTaskSystem.ts)
uses literal argument values for process tasks. `_resolveOptions` converts env
values to strings. `_createShellLaunchConfig` leaves cwd unset when it is empty,
which selects the terminal user home. Shared process startup uses that home fallback.
Windows environment replacement is case-insensitive. Startup diagnostics contain
source locations and error codes, not resolved commands, arguments, or environment values.

Five public keeper contracts in [list.test.mjs](tests/list.test.mjs) verify CLI
argv, cwd, environment, stdin and output; both adapters' platform preparation;
shared lifecycle results; global inheritance; and CLI status and pre-start errors.
The Windows platform probes select Windows configuration on the current host.
They do not prove Windows process startup, executable lookup, or VS Code execution.
Background, dependency execution, matcher evaluation, legacy
execution conformance, and the complete platform release gates remain pending.

### Owned Process Cancellation

The shared executor accepts an `AbortSignal` and returns a distinct `cancelled`
result after owned cleanup. POSIX execution isolates the task group and uses
`pidtree` to include descendants in separate groups. Windows execution uses
`taskkill.exe /PID <pid> /T /F`. Native VS Code tasks retain native termination;
custom terminals cancel the shared executor and release their events after cleanup.

Public contracts cover pre-start cancellation, process and shell descendants,
separate process groups, one completion, no restart, and unrelated-process protection.
CLI probes deliver actual SIGINT and SIGTERM on macOS. The pinned host contract
terminates native and custom process and shell tasks while an unrelated task remains
active. Actual Windows verification remains pending. These checks do not prove
background readiness, dependency cancellation, or compound failure cleanup.

### Shell Startup

`runProcessTask` also starts prepared shell tasks through the shared process lifecycle.
[shell.ts](packages/core/src/shell.ts) adapts the pinned `TerminalTaskSystem`
command-line quoting, shell switches, Windows cmd outer quoting, and PowerShell
invocation operator. Its upstream license notice is retained. The manifest records
the adaptation; the full terminal executor is not imported or compiled.

Preparation retains `originalCommand` before variable substitution. This permits
the pinned command-only rule to distinguish a shell expression from a substituted
executable path. Arrays join with spaces. The pinned `ShellString.from` drops empty
quoted-value objects; a prequoted string `"\"\""` supplies an empty shell argument.
Automatic quoting is based on spaces and existing quotes, not general shell escaping.
Explicit `strong`, `weak`, and `escape` modes use the selected shell's quoting rules.
Custom quoting replaces those rules rather than merging with them.

Shell options merge field by field across global, task, and platform settings.
An explicit shell executable receives only its configured arguments and the command
line. Otherwise the CLI uses `SHELL` or `/bin/sh` on POSIX and `powershell.exe` on
Windows, with pinned command switches. Windows cmd and PowerShell receive verbatim
arguments; Bash and zsh receive an argument vector. VS Code automation profiles
remain the extension adapter's responsibility. The cmd UNC cwd/home restriction
is checked before startup. Actual Windows execution must pass before this issue is done.

Public CLI and shared execution probes check real Bash and zsh quoting, shell
expressions, stdin, environment, cwd, streams, failure, and completion on macOS.
A POSIX launch-capture matrix checks both adapter preparations, platform shell-option
inheritance, cmd and PowerShell command construction, explicit quote modes, and
command-only substitution. It does not prove Windows execution. Real cmd and
PowerShell probe branches are present but have not run on Windows. VS Code
integration and the complete release gates remain pending.

## Reviewed Update Procedure

1. Select a stable upstream tag and resolve its exact commit. Explain the update in the tracked change.
2. Compare the parser, task schemas, matcher schemas, variable resolver, and input schemas with this baseline.
3. Review changed fields, defaults, deprecated aliases, error handling, and runtime behavior.
4. Import the required files by commit URL. Keep license notices and document each adaptation.
5. Update the manifest paths and Git blob hashes. Check them against the upstream Git tree.
6. Update the [fixture inventory](fixtures/README.md) and the affected public contract tests.
7. Run `npm test`. Run affected adapter conformance and macOS and Windows integration checks when those adapters exist.
8. Obtain review before accepting the baseline change. Record the tag and commit in the release notes.

Passing this stage's tests does not satisfy the complete compatibility or platform release gates.
Do not change `releaseReady` or publish a release until the full tracked gates pass.