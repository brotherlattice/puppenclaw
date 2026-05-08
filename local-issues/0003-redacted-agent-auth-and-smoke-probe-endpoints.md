# Request: Redacted Agent Auth And Smoke Probe Endpoints

## Context

OC Science Lab uses a server-local Claude Code OAuth profile. The admin console must prove that the exact Puppenclaw/acpx/Claude path works without ever displaying or storing token material.

## Requested Change

Add daemon endpoints for redacted adapter diagnostics and safe prompt smoke tests.

## Acceptance Criteria

- `GET /agents/claude/status` returns redacted operational details:
  - adapter command configured
  - relevant non-secret env keys and paths
  - whether the Claude adapter can start
  - last error with token-like content redacted
- `POST /agents/claude/smoke` runs a bounded prompt with configured auth and cwd.
- Smoke responses include session name, elapsed time, expected marker observed, warnings, and redacted raw details.
- No endpoint reads or returns Claude credential file contents.
- Timeouts and permission mode are configurable and default to safe values.

## Notes

The app can run direct `claude auth status --json`, but the strongest admin check is through the same Puppenclaw/acpx adapter path that production sessions use.
