# Changelog

## Unreleased

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
