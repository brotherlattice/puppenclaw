---
name: implementation-review-gate
description: Decide whether OpenClaw should continue autonomously or bring the human back before or during a coding run.
user-invocable: false
metadata:
  openclaw:
    requires:
      plugins: ["puppenclaw"]
---

# Implementation Review Gate

## Return to the human only for

- scope change
- meaningful architecture fork
- destructive or risky operation
- missing auth, access, or environment prerequisite
- contradictory evidence that cannot be resolved internally

## Do not return for

- normal implementation choices
- routine file selection
- minor refactors
- expected test/debug loops
- stylistic prompt refinement

## Output

- either:
  - `continue autonomously`
  - or a short decision request with the exact blocked choice and the concrete options
