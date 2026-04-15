---
name: project-refinement
description: Turn vague product or engineering ideas into a concrete implementation brief before Codex or Claude Code execution starts.
user-invocable: false
metadata:
  openclaw:
    requires:
      plugins: ["puppenclaw"]
---

# Project Refinement

## Use when

- the user gives a direction, not an implementation-ready spec
- architecture tradeoffs are still unresolved
- success criteria or non-scope are missing
- the backend would otherwise receive a weak prompt

## Produce

- a concise problem statement
- explicit scope and non-scope
- constraints and assumptions
- architecture direction with tradeoffs
- files or systems likely to change
- validation and test expectations
- open questions that truly require the human

## Escalate to the human only for

- product scope choice
- architecture fork with real tradeoffs
- destructive migration / security / access concerns
- missing external credentials or permissions
