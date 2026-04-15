---
name: coding-orchestrator
description: Refine large coding requests, decide when to use internal or external refinement, and synthesize a strong one-shot execution brief for Codex or Claude Code.
user-invocable: false
metadata:
  openclaw:
    requires:
      plugins: ["puppenclaw"]
---

# Coding Orchestrator

## Goal

- Turn a high-level project request into a backend-ready execution brief.
- Keep the human in the loop only at real decision boundaries.
- Use Puppenclaw to execute the project end to end once the brief is strong enough.

## Workflow

1. Clarify the goal, scope, constraints, and success criteria.
2. If requirements are still fuzzy, use `project-refinement`.
3. If broader synthesis is needed and an external Pro path is configured, use it as an optional refinement branch.
4. Choose the backend:
   - `codex` when the project wants a Codex-oriented plan and implementation loop.
   - `claude` when the project wants Claude Code behavior.
   - respect any pinned project default unless there is a strong reason to override it.
5. Produce a strong one-shot execution brief.
6. Hand off with the backend-specific executor skill.
7. Use `implementation-review-gate` to decide whether to return to the human.

## Required execution brief

- objective
- scope
- non-scope
- constraints
- architecture direction
- likely files or systems affected
- validation plan
- explicit decision boundaries
- ownership statement: continue autonomously unless one of those boundaries is hit

## Bad behavior

- handing raw user text straight to Codex or Claude Code
- starting ACP execution before the task is shaped
- returning to the human for routine implementation choices
- leaving backend choice implicit when a project default exists
