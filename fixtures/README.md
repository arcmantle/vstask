# Compatibility Fixture Inventory

Baseline: VS Code `1.105.1`, commit `7d842fb85a0275a4a8e4d7e040d2625abbf7f084`.
See [baseline.json](../baseline.json) for immutable source paths and hashes.

## Verification States

The listing fixtures verify the parser-to-CLI path and source locations.
The full-field seed verifies preservation of unresolved configuration through the public core API.
Preservation is not semantic normalization, variable resolution, or execution compatibility.
Temporary task files in the CLI tests verify canonical identities and exact selection.
They cover duplicate files and roots, overlapping roots, unique labels, file-qualified selectors,
canonical priority, repeated roots, and ambiguity errors with usable canonical identities.
CLI candidate contracts verify partial names, typing errors, long-name substring
matches, score order, canonical deduplication, qualified names, exact priority,
configurable thresholds, invalid options, and blank or unrelated queries. A startup
marker verifies that candidate listing does not run tasks. Candidate prompts and
fuzzy execution remain pending.
Public core tests verify task workspace paths, named-folder references within one
discovery root, and preserved task metadata. The workspace path matrix checks default,
relative, absolute, empty, non-string, and deferred cwd values before and after a task
file moves. Adapter execution and Windows integration remain pending.
Public core graph fixtures verify exact local string references, native identifier
aliases, label priority, task-file duplicate order, sequence/parallel defaults,
shared-node reuse, and selected-graph missing-target and cycle errors.
See the [native graph baseline](../BASELINE.md#native-dependency-graph) for source evidence.
Object references, extended lookup, and dependency execution remain pending.
Public variable probes verify execution-field substitution through both adapter
preparation APIs against the unchanged pinned evaluator. They cover every
context-independent built-in variable, scalar and array settings, nested replacements,
environment keys and values, shell fields, relative cwd, and literal labels.
Core contracts also check Windows and POSIX environment lookup, folder-scoped settings,
selected-graph-only resolution, shared nodes, required-value errors, and routing to
dedicated editor, host, and provider resolvers. No probe starts a task.
See the [variable contract](../BASELINE.md#built-in-variable-resolution) for the complete
inventory and error rules. Editor and provider execution, process startup, and actual
Windows and VS Code integration are not verified by these probes.
Public input contracts use actual Inquirer controls for text, masked passwords,
configured defaults, and labeled choices. Adapter preparation tests verify supplied
`id=value` entries, empty values, file-qualified overrides, last definitions,
repeated and nested references, shared nodes, and selected-plan-only resolution.
Startup probes remain untouched when a required input is missing, invalid, or
canceled. Command inputs use supplied values or an explicit callback; unavailable
and invalid callback results fail without exposing supplied values. These tests
verify preparation, not process execution or installed VS Code providers.
Process probes now execute temporary task files through CLI exact selection and
the shared process API. They verify spaces, empty arguments, literal quote values,
Unicode, inherited and task environments, task-relative cwd, file command defaults,
empty-cwd home fallback, stdin, separate output streams, nonzero exits, and safe
startup errors. Both adapter preparation APIs select macOS and Windows command
overrides before variable resolution. Windows environment replacement is checked
on the current host; actual Windows startup and VS Code integration remain pending.
CLI failure probes verify that missing inputs and unsupported provider,
background, or dependency execution do not start tasks. Shared completion follows
stream closure and is emitted once. These are process-stage checks, not complete
execution conformance. See the [process contract](../BASELINE.md#process-startup).
Shell probes execute configured Bash and zsh on macOS with automatic and explicit
quoting, empty quoted strings, metacharacters, command-only expressions, stdin,
environment, cwd, separate streams, nonzero exits, and startup failures.
The launch-capture matrix checks both adapter preparations and POSIX, cmd, and
PowerShell command construction, array values, custom quoting, original commands,
and global/task/platform shell-option inheritance. This matrix runs on POSIX and
does not prove Windows execution. Real cmd and PowerShell probes are present;
their actual Windows results and VS Code integration remain pending.
See the [shell contract](../BASELINE.md#shell-startup).
Cancellation contracts run real process and shell trees with two descendant levels
and an unrelated control process. They cover separate descendant groups, pre-start
cancellation, one completion after cleanup, and no restart. CLI probes deliver
SIGINT and SIGTERM and check cancellation exit codes. The pinned VS Code host
terminates native and custom process and shell tasks while an unrelated execution
remains active. These contracts passed on macOS; Windows tree and console-signal
verification remain pending. See the [cancellation contract](../BASELINE.md#owned-process-cancellation).
Group contracts verify normalized string/object groups, boolean/pattern defaults,
invalid group IDs, legacy flags, source preservation, and pinned label-inference order
through the public core API. The pinned macOS host runs standard build/test commands
with native and custom defaults. It checks distinct duplicate-label identities and
details, exact selection, matching-pattern priority, editor changes, nonmatching/no-editor/
untitled-editor fallback, multiple pattern defaults, and unchanged task files.
Windows group verification remains pending. See the [group baseline](../BASELINE.md#task-groups).
All adapter behavior and scenario variations below are **pending** unless stated otherwise.
No fixture authorizes task execution. The provider in the seed is deliberately unavailable.

## Input Seeds

- [listing](listing/.vscode/tasks.json): comments, trailing commas, task label, and source location. Verified through CLI listing.
- [duplicate properties](duplicate-properties/.vscode/tasks.json): effective task array and label location. Verified through CLI listing.
- [built-in](built-in/.vscode/tasks.json): modern fields, nested configuration, platform blocks, and inputs. Data preservation is verified.
- [legacy](legacy/.vscode/tasks.json): version `0.1.0`, legacy names, global command options, platform tasks, and matcher aliases. Conformance is pending.
- [matcher output](built-in/output.txt): begin, multiline problems, repeated problems, and readiness. Matcher evaluation is pending.
- [workspace paths](workspace-paths.json): pinned variable and cwd sources with path expectations. Verified through the public core path resolver.

## Field Inventory

Each row identifies a seed and the required scenario variations. A seed is not evidence that its execution works.
Root and task-level settings must both be checked where the baseline parser permits them.
Use the unchanged upstream references to check valid contexts and defaults; not all parser properties appear in the current schema.

| Area | Fields | Seed and required variations |
| --- | --- | --- |
| Document | `version`, `tasks`, `windows`, `osx`, `linux`, `runner`, `_runner` | Built-in and legacy; version `2.0.0`, `0.1.0`, absent and unknown versions; global command with no tasks; platform task replacement rules. |
| Task identity | `label`, `taskName`, `identifier`, `type`, `customize` | Built-in and legacy; label precedence, absent labels, shell/process/custom tasks, contributed identifiers and unavailable providers. |
| Commands | `command`, `args`, quoted `value` and `quoting` | Built-in; string and array commands; string and quoted arguments; `escape`, `strong`, `weak`; spaces, empty arguments, quotes and Unicode. |
| Command options | `options.cwd`, `options.env`, `options.shell.executable`, `options.shell.args` | Built-in; relative/absolute/default cwd; environment inheritance and overrides; platform shell selection. |
| Shell quoting | `options.shell.quoting.escape`, `escapeChar`, `charsToEscape`, `strong`, `weak` | Built-in; string and object escape forms; platform-specific escape and quote rules. |
| Platform blocks | `windows`, `osx`, `linux`: `command`, `args`, `options`, `problemMatcher` | Built-in and legacy; global/task precedence, argument replacement versus legacy merging, unmatched platform, matcher replacement. |
| Task properties | `isBackground`, `promptOnClose`, `group.kind`, `group.isDefault`, `detail`, `icon.id`, `icon.color`, `color`, `hide` | Built-in; defaults; build/test/none groups; string/object groups; boolean/glob defaults; build/test label inference; hidden tasks and terminal icons. |
| Dependencies | `dependsOn`, identifier `type` and provider-defined fields, `dependsOrder` | Built-in; string/object/array references; parallel/sequence; missing targets, cycles, shared dependencies, failure and cancellation. |
| Presentation | `presentation.reveal`, `revealProblems`, `echo`, `focus`, `panel`, `showReuseMessage`, `clear`, `group`, `close`, `preserveTerminalName` | Built-in; always/silent/never; always/onProblem/never; shared/dedicated/new; split groups; successful/error exits; terminal reuse and task streams. |
| Run options | `runOptions.reevaluateOnRerun`, `runOn`, `instanceLimit`, `instancePolicy` | Built-in; rerun values; default/folderOpen; limits and clamp behavior; terminateNewest/terminateOldest/prompt/warn/silent; trust and explicit permission. |
| Inputs | `inputs[].id`, `type`, `description`, `default`, `password`, `options`, option `label`/`value`, `command`, `args` | Built-in; promptString/pickString/command; string/object choices; object/array/string command args; defaults, supplied values, cancellation, missing values and unavailable command providers. |
| Matchers | `problemMatcher`, `declares[].name`, `base`, `owner`, `source`, `severity`, `applyTo`, `fileLocation`, `pattern` | Built-in; absent/empty/string/object/mixed-array matchers; inheritance; error/warning/info; all/open/closed documents; named matcher and pattern registries. |
| Matcher paths | `fileLocation` mode/prefix and search `include`/`exclude` | Built-in and legacy; absolute/relative/autoDetect/search; one-item and two-item forms; string/array search paths; missing and duplicate files. |
| Problem patterns | `regexp`, `kind`, `file`, `location`, `line`, `column`, `endLine`, `endColumn`, `severity`, `code`, `message`, `loop`; registered pattern `name`/`patterns` | Built-in, legacy and output; named/single/multiline patterns; repeated final pattern; file versus location kind; default groups; invalid expressions; split output chunks. |
| Background matchers | `background.activeOnStart`, `beginsPattern`, `endsPattern`; pattern object `regexp`/`file` | Built-in and output; active/inactive start; string/object patterns; repeated cycles; readiness distinct from exit; later service failure. |
| Legacy properties | `isShellCommand`, `showOutput`, `echoCommand`, `terminal`, `suppressTaskName`, `taskSelector`, `isWatching`, `isBuildCommand`, `isTestCommand` | Legacy; aliases and modern-property precedence; terminal uses the complete presentation field set; global inheritance and task-name arguments. |
| Legacy matchers | `watching`, `watchedTaskBeginsRegExp`, `watchedTaskEndsRegExp` | Legacy; background-field precedence and legacy begin/end behavior. |

## Behavior Inventory

These requirements are not all expressible as task-file fields. Their conformance remains pending.

- Parsing: BOM, LF/CRLF/CR line endings, block/line comments, trailing commas, duplicate properties, empty documents, malformed syntax and invalid task shapes.
- Variables: `env`, `config`, `command`, `input`, `workspaceFolder`, `workspaceFolderBasename`, `cwd`, `userHome`, `file`, `fileWorkspaceFolder`, `fileWorkspaceFolderBasename`, `relativeFile`, `relativeFileDirname`, `fileDirname`, `fileExtname`, `fileBasename`, `fileBasenameNoExtension`, `fileDirnameBasename`, `selectedText`, `lineNumber`, `columnNumber`, `execPath`, `execInstallFolder`, `extensionInstallFolder`, `pathSeparator`, `/`, and `defaultBuildTask`.
- Variable variations: named-folder arguments, platform paths, Windows environment-name case, deprecated `workspaceRoot` and `workspaceRootFolderName`, unknown variables, missing editor context, selected-plan-only resolution, and input/command evaluation. Keep provider-dependent behavior within the approved adapter boundary.
- Discovery: root/nested files, canonical identity, duplicate labels, separate roots, exclusions and overrides, directory links, invalid/unreadable files, and file refresh.
- Selection: exact selectors first; unique short selectors; Fuse.js substring/typo matching; one/multiple/no matches; interactive prompts; non-interactive exact default and explicit fuzzy opt-in.
- Extended dependencies: exact local labels win, including literal `ws:` labels; unmatched `ws:` references use unique same-root lookup; qualified duplicates; ambiguity, root isolation and unreliable lookup errors.
- Execution: sequential/parallel plans, shared dependencies, process and shell quoting, environment, standard streams, readiness, exit status, compound failure cleanup, cancellation, descendant ownership and unrelated-process protection.
- VS Code: standard task interface, native versus CustomExecution routing, installed providers, integrated terminals, diagnostics, refresh, run options, trust and automatic-task permission.
- CLI: attached background services, Inquirer, Ora, non-interactive inputs, versioned NDJSON events, one final run-status event, structured errors and secret-free diagnostic metadata.
- Distribution: extension-supplied CLI, consent-based external setup, command replacement, installed Node.js/Bun/Deno selection, managed updates, active-run protection, rollback and setup-owned removal.
- Release: shared conformance, VS Code integration, runtime checks and installation lifecycle on macOS and Windows. Linux is optional.

## Upstream References

The task fields and defaults come from `taskConfiguration.ts`, `jsonSchemaCommon.ts`,
`jsonSchema_v2.ts`, and `jsonSchema_v1.ts` in the manifest.
Matcher fields come from `Schemas` and the parsers in `problemMatcher.ts`.
Input fields come from `configurationResolverSchema.ts`.
Variable branches come from [variableResolver.ts at the pinned commit](https://github.com/microsoft/vscode/blob/7d842fb85a0275a4a8e4d7e040d2625abbf7f084/src/vs/workbench/services/configurationResolver/common/variableResolver.ts).
Registry-backed variables and patterns also need adapter-provider checks.

Before release, turn every pending variation into an executable public-interface fixture,
record its adapter results, and obtain review. Do not infer conformance from successful data preservation.