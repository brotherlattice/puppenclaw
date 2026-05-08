# Request: Session Workspace And Skill Metadata

## Context

OC Science Lab creates one workspace per chat. Each Claude session must know its workspace folder, skill bundle snapshot, intended report artifacts, and Slurm workflow lifecycle.

## Requested Change

Allow first-class metadata on Puppenclaw sessions and expose it through status/events.

## Acceptance Criteria

- `session/start` accepts optional metadata:
  - `workspaceId`
  - `workspacePath`
  - `skillBundles`
  - `artifactKinds`
  - `parentSessionName`
  - `environmentInheritance`
- Metadata is persisted with session state and returned from status/list endpoints.
- Metadata is included in event stream session-start events.
- Context files or skill instructions can be attached without overloading the user prompt.
- Existing callers remain compatible when metadata is absent.

## Notes

This lets the lab app keep strict per-chat folder semantics while Puppenclaw remains the ACP execution authority.
