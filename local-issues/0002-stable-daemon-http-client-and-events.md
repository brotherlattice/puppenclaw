# Request: Stable Daemon HTTP Client And Event Stream

## Context

OC Science Lab should treat Puppenclaw as a dependency through a stable daemon API. The app needs predictable routes for chat/session lifecycle, event streaming, artifact discovery, and admin health checks.

## Requested Change

Publish a small typed HTTP client and stabilize daemon event semantics.

## Acceptance Criteria

- A typed client can call health, session start/send/resume/fork/status/cost, artifacts, logs, and campaign events.
- The client uses exported request/response schemas from Puppenclaw.
- Session events expose enough structure for a web transcript: role, text, tool progress, warnings, cost, and completion state.
- Long-running event streams have documented reconnect and cursor behavior.
- Health reports daemon version, config summary, active session count, and stream support.

## Notes

`pyPuppenclaw` already mirrors much of the HTTP surface in Python. The lab app needs the equivalent TypeScript surface for the Next.js/worker runtime.
