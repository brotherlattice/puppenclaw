---
name: claude-code-plan-executor
description: Convert a refined project brief into a strong Claude Code-oriented planning-first execution handoff.
user-invocable: false
metadata:
  openclaw:
    requires:
      plugins: ["puppenclaw"]
---

# Claude Code Plan Executor

## Handoff shape

- start with a focused planning-first brief
- include:
  - objective
  - scope and non-scope
  - constraints
  - architecture direction
  - likely files or systems affected
  - validation plan
  - decision boundaries that require human return

## Backend guidance

- keep the strategic plan explicit before implementation begins
- preserve repository-specific constraints and memory
- prefer specialized sub-work within the backend rather than one shapeless implementation blob
- keep the human out of the loop unless a real decision boundary is reached
