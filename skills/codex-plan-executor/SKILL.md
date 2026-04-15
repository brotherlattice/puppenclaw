---
name: codex-plan-executor
description: Convert a refined project brief into a strong Codex-oriented planning-first execution handoff.
user-invocable: false
metadata:
  openclaw:
    requires:
      plugins: ["puppenclaw"]
---

# Codex Plan Executor

## Handoff shape

- state that Codex should plan first, then implement end to end
- include:
  - objective
  - scope and non-scope
  - constraints
  - architecture direction
  - likely files or systems affected
  - test and validation plan
  - decision boundaries that require human return

## Backend guidance

- prefer one strong, detailed planning brief over incremental micromanagement
- keep repository constraints explicit
- request explicit ownership of implementation and validation
- require return to the human only for decision boundaries, not normal implementation details
