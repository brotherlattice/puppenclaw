# Request: Make Puppenclaw Daemon Standalone Without OpenClaw

## Context

OC Science Lab needs to run Puppenclaw as a sidecar HTTP daemon. The lab app should depend on the daemon API, not on OpenClaw plugin internals.

Current inspection shows the daemon CLI exists, but the package is still shaped as an OpenClaw plugin:

- `package.json` declares `openclaw` as a peer dependency.
- `tsup.config.ts` externalizes `openclaw`.
- `src/plugin/config.ts` has a runtime import from `openclaw/plugin-sdk/core` for `DEFAULT_ACCOUNT_ID`.
- daemon entrypoints call shared plugin config helpers.

That means `puppenclaw-daemon start` can still fail in a clean non-OpenClaw deployment.

## Requested Change

Split the daemon runtime from OpenClaw plugin runtime dependencies.

## Acceptance Criteria

- `puppenclaw-daemon start --host 127.0.0.1 --port 18795 --data-dir ...` works with no `openclaw` package installed.
- daemon code has no runtime import from `openclaw/plugin-sdk/core`.
- OpenClaw plugin registration remains available for OpenClaw users.
- daemon config parsing lives in a shared, plugin-agnostic module.
- package metadata makes OpenClaw optional/plugin-only for daemon consumers.
- CI covers a daemon startup smoke test in an environment without OpenClaw installed.

## Suggested Implementation

- Move `DEFAULT_ACCOUNT_ID` fallback into Puppenclaw shared config, or duplicate the literal default in a local constant.
- Keep OpenClaw-only helpers in `src/plugin/*`.
- Make daemon entrypoints import only `src/shared`, `src/manager`, `src/orchestrator`, and `src/daemon`.
- Consider a package export such as `@puppenclaw/openclaw-plugin/daemon-client` for typed daemon consumers.
