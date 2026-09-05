# @treythomascodes/pi-subagent-lite

A minimal pi extension that delegates tasks to isolated subagent processes.

Requires Node.js 22.19 or newer, matching the current `@earendil-works/pi-*` packages.

## Fork provenance

This repository is a fork of [@jerryan/pi-subagent-lite](https://github.com/JerryAZR/pi-subagent-lite), originally authored by jerryan (GitHub: [JerryAZR](https://github.com/JerryAZR)). It is independently maintained by TreyThomasCodes and includes additional fixes and improvements.

The original MIT license and copyright notices are preserved in [`LICENSE`](LICENSE).

## What makes this different?

Lightweight delegation without agent definition files or a separate configuration system. Choose a model per task and reuse your existing pi skills when you need specialization.

- **Zero setup**: Install via pi and use it in the next session. No agent directories to manage, no agent definitions to write.
- **Minimal interface**: A required `task`, with optional `model`, `thinking`, and `skills`. No agent definitions or working-directory overrides.
- **No agent definitions**: Unlike almost every other subagent tool, we don't use `~/.pi/agent/agents/*.md` or any custom agent discovery. If you need specialization, **reuse your existing pi skills** via the `skills` parameter.
- **One focused system prompt**: Every subagent gets the same lean, task-oriented prompt designed for delegation and clear reporting.
- **Transparent long-task handling**: Tasks longer than 4000 chars are automatically spilled to a temp file so they never hit CLI length limits.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Live progress**: See turn-by-turn updates as the subagent works
- **Model discovery**: Get the isolated child's live model catalog, including selectors, capabilities, token limits, thinking levels, and configured cost metadata
- **Per-call model selection**: Choose a different model for each subagent with Pi's native `--model` selectors
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

With skills:

```
Run a subagent with skills ["code-review"] to review src/auth.ts
```

You can also invoke multiple subagents in parallel by making separate tool calls in the same turn, each with its own model.

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
  "model": "provider/model",
  "thinking": "high",
  "skills": ["code-review"]
}
```

- Prefer a full selector returned by `subagent_models`, usually `provider/model`, to avoid ambiguity. Pi shorthand selectors also work when they resolve uniquely.
- Set `thinking` to Pi's explicit level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`). It is passed as `--thinking` and shown separately in the subagent window. Pi's `:thinking` model-selector suffix is also passed through for backwards compatibility.
- Use `subagent_models` before the first model-selected delegation in a fresh session, and again after changing model configuration. It queries Pi RPC against the same environment as the isolated child. Select explicitly based on objective needs such as image input, context, output budget, thinking support, and configured cost metadata; the catalog does not establish relative model quality, actual billing, latency, or reliability. Providers, authentication, and custom models must be configured for the child Pi process as usual; no separate subagent credentials are needed. Parent-only in-memory configuration is not copied into the child.
- **When omitted**, no `--model` flag is passed. The child uses Pi's normal configured default/fallback selection, preserving the original behavior. It does **not** automatically inherit the parent session's active model, and selecting a subagent model does not change the parent's model.
- Leading/trailing whitespace is trimmed. Empty or whitespace-only selectors are rejected. Model resolution and provider errors from Pi are reported as tool failures.
- The requested model and explicit thinking level are shown in the tool header and initial progress update.

## Tool Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | `string` | Yes | The task to delegate to the subagent |
| `model` | `string` | No | A selector returned by `subagent_models`, preferably `provider/model`, passed via `--model`; defaults to the child Pi process's normal model selection |
| `thinking` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` | No | Child thinking level, passed via `--thinking` and displayed beside the model |
| `skills` | `string[]` | No | Optional skill paths or names to load via `--skill` |

## License

MIT © jerryan
