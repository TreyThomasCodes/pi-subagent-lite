# Changelog

## Unreleased

- Added optional `allowedPaths` workspace-write contracts with bounded Git-based net-change reports, nested-cwd support, explicit unavailable/partial diagnostics, and out-of-scope path flags; reports are observational and do not sandbox or roll back writes.
- Added bounded timeout, cancellation, and abnormal-exit recovery diagnostics with sanitized progress tails, root-exit evidence, and explicit process-tree verification limits.
- Preflight explicit model selectors with the same Pi runtime used by `subagent_models`, preserving native selector resolution and rejecting invalid selections before a task child starts.
- Defined a generic delegation packet and provisional-result contract in parent guidance, the child system prompt, examples, and tests.
- Added per-process workspace-write leases that reject concurrent subagents targeting the same working directory while preserving parallel read-only and different-directory calls.
- Added optional bounded subagent runtimes with distinct timeout/cancellation errors and cross-platform process-tree termination.
- Added explicit `read-only` and `workspace-write` subagent access modes. Read-only children receive only Pi's `read`, `grep`, `find`, and `ls` tools; omitted access preserves the existing workspace-write behavior.
- Renamed the independently maintained fork to `@treythomascodes/pi-subagent-lite`, preserving the original author and MIT license attribution.
- Added an optional per-call `model` parameter using Pi's native `--model` selectors, with the requested model visible in the tool header and initial progress.
- Preserved Pi's default model selection when `model` is omitted; blank selectors are rejected.
- Fixed tool failure signaling and rendering so child-process/model errors are not reported as successful runs.
- Updated installation instructions to use this fork and CI to use the minimum supported Node.js version.
- Migrated Pi imports and peer dependencies to the `@earendil-works/pi-*` packages.
- Raised the minimum Node.js version to 22.19 to match the current Pi packages.

## 0.1.3

- Added missing `pi` manifest to `package.json` so pi can auto-discover the extension when installed as a package.

## 0.1.2

- Fixed extension not loading in main pi session due to collision with `PI_CODING_AGENT` env var. Now uses `PI_SUBAGENT_LITE_DISABLE` to prevent recursive nesting only in subagent processes.
