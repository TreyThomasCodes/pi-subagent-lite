# @treythomascodes/pi-subagent-lite

A minimal pi extension that delegates tasks to isolated subagent processes.

Requires Node.js 22.19 or newer, matching the current `@earendil-works/pi-*` packages.

## Fork provenance

This repository is a fork of [@jerryan/pi-subagent-lite](https://github.com/JerryAZR/pi-subagent-lite), originally authored by jerryan (GitHub: [JerryAZR](https://github.com/JerryAZR)). It is independently maintained by TreyThomasCodes and includes additional fixes and improvements.

The original MIT license and copyright notices are preserved in [`LICENSE`](LICENSE).

## What makes this different?

Lightweight delegation without agent definition files or a separate configuration system. Choose a model per task and reuse your existing pi skills when you need specialization.

- **Zero setup**: Install via pi and use it in the next session. No agent directories to manage, no agent definitions to write.
- **Minimal interface**: A required `task`, with optional `access`, `model`, `thinking`, `timeoutMs`, and `skills`. No agent definitions or working-directory overrides.
- **No agent definitions**: Unlike almost every other subagent tool, we don't use `~/.pi/agent/agents/*.md` or any custom agent discovery. If you need specialization, **reuse your existing pi skills** via the `skills` parameter.
- **One focused system prompt**: Every subagent gets the same lean, task-oriented prompt designed for delegation and clear reporting.
- **Transparent long-task handling**: Tasks longer than 4000 chars are automatically spilled to a temp file so they never hit CLI length limits.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Live progress**: See turn-by-turn updates as the subagent works
- **Model discovery**: Get the isolated child's live model catalog, including selectors, capabilities, token limits, thinking levels, and configured cost metadata
- **Per-call access modes**: Enforce a `read-only` Pi tool allowlist or preserve normal tools with `workspace-write`
- **Preflighted model selection**: Choose a different model for each subagent with Pi's native `--model` selectors, validated before the task child starts
- **Bounded runtime**: Optionally cap a child run and terminate its process tree on timeout or caller cancellation
- **Workspace-write coordination**: Reject concurrent writers targeting the same working directory while preserving parallel read-only work
- **Optional skills**: Preload capabilities via `--skill` flags
- **Auto-spill**: Long tasks (>4000 chars) are automatically written to a temp file to avoid CLI limits
- **Clean result rendering**: Final output is clearly marked with a `✓ --- Result ---` separator
- **No recursive nesting**: When running inside a subagent process, the tool automatically unregisters itself so subagents cannot spawn further subagents

## Installation

```bash
pi install git:github.com/TreyThomasCodes/pi-subagent-lite
```

Install from this fork to get its improvements; the original `@jerryan/pi-subagent-lite` npm package does not contain them. If that package is already installed, remove it first with `pi remove npm:@jerryan/pi-subagent-lite` to avoid duplicate `subagent` tools.

The extension will be available the next time you start a pi session.

To try it without installing permanently:

```bash
pi -e git:github.com/TreyThomasCodes/pi-subagent-lite
```

For local development, run inside the repo:

```bash
pi -e .
```

To validate changes:

```bash
npm ci
npm run check
npm test
```

## Usage

Once installed, the `subagent_models` and `subagent` tools are available. In a fresh session, discover the child-compatible catalog before delegating with an explicit model:

```
List the models available to isolated subagents
```

Then delegate using a selector the discovery tool returned:

```
Run a subagent using provider/model to find all test files in the project
```

For a bounded adversarial review:

```json
{
  "task": "Objective: adversarially review token refresh handling for races and stale-session use.\nScope: src/auth.ts, its direct callers, and focused tests.\nAccess expectations: inspect only; do not edit files.\nExclusions: unrelated authentication flows, dependencies, and configuration.\nVerification: trace each refresh path and compare behavior with existing tests.\nStopping conditions: stop after every in-scope path is assessed, or report a blocker if required context is unavailable.\nReport format: findings ordered by severity with file/line evidence, checks performed, blockers, and uncertainty.",
  "access": "read-only",
  "model": "provider/model",
  "thinking": "high"
}
```

For a bounded implementation task with skills:

```json
{
  "task": "Objective: fix the confirmed stale-session bug.\nScope: src/auth.ts and test/auth.test.ts.\nAccess expectations: modify only those files.\nExclusions: no dependency, configuration, or public API changes.\nVerification: run the focused auth test command and report its exact outcome.\nStopping conditions: stop and report a blocker if the fix requires broader schema or API changes.\nReport format: changed files, implementation summary, commands actually run with outcomes, blockers, and uncertainty.",
  "access": "workspace-write",
  "timeoutMs": 600000,
  "skills": ["code-review"]
}
```

### Writing a delegation packet

The interface remains one `task` string rather than an agent-definition format. For non-trivial work, make that string a bounded packet that states the objective, scope, access expectations, exclusions, verification, stopping conditions, and desired report format. Include only fields relevant to the task, but make boundaries and expected evidence explicit.

The child's final text is a provisional report. A successful `subagent` tool result means the child returned normally; it does not by itself prove that tests passed, that every claim is correct, or that the parent should accept the work. The child is asked to identify commands and checks actually run, their outcomes, unresolved blockers, and uncertainty. The parent remains responsible for reviewing the report and workspace state before deciding next steps.

You can also invoke multiple read-only subagents in parallel by making separate tool calls in the same turn. Workspace-writing calls can run in parallel only when their working directories differ.

### Choosing an access mode

`access` controls which Pi tools the child receives:

- `read-only` passes Pi the strict allowlist `read,grep,find,ls`. Shell tools (`bash` and `powershell`), file mutation tools (`edit` and `write`), and other extension/custom tools are not enabled.
- `workspace-write` passes no tool override and therefore preserves the child Pi process's normal configured tool set. This is the default when `access` is omitted, preserving compatibility with earlier versions.

The selected mode is shown in the tool call and initial progress update. These modes control the child's callable Pi tools; they are **not an operating-system sandbox**. The child still inherits the parent process environment and working directory, and filesystem visibility is not isolated. `workspace-write` does not confine writes to that directory, while `read-only` cannot prevent loaded extension startup/lifecycle code, another process, or external tools from changing files. Review trusted skills, context files, and extensions accordingly.

### Coordinating workspace writes

Within one extension process, only one `workspace-write` subagent may run against a resolved working directory at a time. A second same-directory writer is rejected immediately with guidance to wait, use `read-only`, or choose a different working directory; calls are not silently queued. The lease is released after success, child failure, timeout, caller cancellation, or spawn failure. Read-only calls do not take a mutation lease, and writers using different working directories do not contend.

This is a local coordination guard, not a filesystem lock or sandbox. It cannot stop the parent agent, another Pi/extension process, or an external tool from writing concurrently. Different working directories may still target the same files because `workspace-write` does not confine filesystem access. The extension does not create Git worktrees or impose repository-specific execution phases.

### Setting a deadline

Set `timeoutMs` to an integer from `1000` (one second) through `86400000` (24 hours) to cap the child process runtime. The deadline appears in the tool call and initial progress update. When omitted, the extension imposes no deadline, preserving existing behavior.

A deadline failure reports `Subagent timed out after ...` separately from caller cancellation (`Subagent aborted by caller`) and child model/provider failures. On timeout or cancellation, the extension terminates the Pi process tree using a detached process group on Unix-like platforms and Windows `taskkill /T` on Windows. Temporary prompt/task files and deadline listeners are still cleaned up.

This is an overall child runtime cap, not a project-specific test-command policy. Put narrower command timeouts in the delegated task or project tooling when needed.

### Choosing a model

First call `subagent_models`; it runs the same Pi executable and configuration as an isolated child and returns a structured live catalog. This avoids guessing which providers and model selectors are available, and lets the parent compare each model's modality, exact thinking levels, token limits, configured cost metadata, and supported tool capabilities.

Then choose one of the returned selectors:

```text
Run a subagent using provider/model to find all test files in the project
```

Or specify it in a `subagent` tool call, with or without skills:

```json
{
  "task": "Review src/auth.ts for security issues and summarize your findings",
  "access": "read-only",
  "model": "provider/model",
  "thinking": "high",
  "skills": ["code-review"]
}
```

- Prefer a full selector returned by `subagent_models`, usually `provider/model`, to avoid ambiguity. Pi shorthand selectors also work when they resolve uniquely.
- Before starting the task-bearing child, an explicit selector is checked by starting the same Pi executable and configuration in a short-lived RPC validation process. Pi performs its own exact/pattern/`:thinking` resolution; the extension does not implement a competing matcher. If Pi rejects the selector, no task child starts and the error directs you to refresh `subagent_models`. A configuration race after preflight can still cause the task child to fail normally.
- Set `thinking` to Pi's explicit level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`). It is passed as `--thinking` and shown separately in the subagent window. Pi's `:thinking` model-selector suffix is also passed through for backwards compatibility.
- Use `subagent_models` before the first model-selected delegation in a fresh session, and again after changing model configuration. It queries Pi RPC against the same environment as the isolated child. Select explicitly based on objective needs such as image input, context, output budget, thinking support, and configured cost metadata; the catalog does not establish relative model quality, actual billing, latency, or reliability. Providers, authentication, and custom models must be configured for the child Pi process as usual; no separate subagent credentials are needed. Parent-only in-memory configuration is not copied into the child. A discovery/startup failure during preflight is reported separately from a selector Pi rejected.
- **When omitted**, no `--model` flag is passed and no catalog preflight occurs. The child uses Pi's normal configured default/fallback selection, preserving the original behavior. It does **not** automatically inherit the parent session's active model, and selecting a subagent model does not change the parent's model.
- Leading/trailing whitespace is trimmed. Empty or whitespace-only selectors are rejected. Model resolution and provider errors from Pi are reported as tool failures.
- The requested model and explicit thinking level are shown in the tool header and initial progress update.

## Tool Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | `string` | Yes | Bounded delegation task; for non-trivial work, state objective, scope, access expectations, exclusions, verification, stopping conditions, and report format |
| `access` | `"read-only" \| "workspace-write"` | No | Child tool access mode; defaults to `workspace-write`. `read-only` enables only `read`, `grep`, `find`, and `ls` |
| `model` | `string` | No | A Pi selector, preferably one returned by `subagent_models`; preflighted with the same child Pi executable before passing it via `--model`; omitted uses the child Pi process's normal model selection |
| `thinking` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` | No | Child thinking level, passed via `--thinking` and displayed beside the model |
| `timeoutMs` | `integer` | No | Maximum child runtime in milliseconds, from `1000` through `86400000`; omitted means no extension-imposed deadline |
| `skills` | `string[]` | No | Optional skill paths or names to load via `--skill` |

## License

MIT © jerryan
