---
name: puppenclaw-orchestration
description: Route repo work into Puppenclaw-managed ACP sessions and use oc2oc remote control safely.
user-invocable: false
metadata:
  openclaw:
    requires:
      plugins: ["puppenclaw"]
---

# Puppenclaw Orchestration Policy

## Use Puppenclaw when

- The user wants work done inside a repo, workspace, or server project.
- The task needs file edits, shell commands, tests, builds, or git operations.
- The task is multi-step and benefits from a persistent Claude Code or Codex session.
- The request comes through `oc2oc` and should be delegated to a remote coding agent.

## Prefer mediated orchestration

- When a remote `oc2oc` message asks for code work, treat Puppenclaw as the execution backend and keep the remote agent in charge of delegation.
- Reuse an existing session for the same `agent + directory` before starting a new one.
- Attach explicit context files such as `AGENTS.md`, `agents.md`, or small task notes when they are already available.

## Pure-pipe remote control

- Use deterministic `/puppenclaw ...` commands only when the target conversation is explicitly bound and exposed for pure-pipe control.
- If no binding exists, request `/puppenclaw bind`.
- If the conversation is bound but not exposed, require `/puppenclaw expose`.
- Never assume pure-pipe remote control is allowed by default.

## Agent choice

- Prefer `agent: "codex"` for Codex-oriented coding loops.
- Prefer `agent: "claude"` when the operator explicitly wants Claude Code behavior.
- Keep the requested agent stable for the life of the session unless the user asks to switch.

## When not to use Puppenclaw

- The user only wants an explanation, review, or architecture discussion.
- The task is a short inline snippet with no repo interaction.
- The user explicitly says not to run tools or not to touch the codebase.
