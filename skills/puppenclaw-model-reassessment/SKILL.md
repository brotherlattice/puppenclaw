---
name: puppenclaw-model-reassessment
description: Reassess older Puppenclaw, Codex, and Claude Code sessions with a newer model and produce conservative patch branches plus importance-ranked reports.
user-invocable: false
metadata:
  openclaw:
    requires:
      plugins: ["puppenclaw"]
---

# Puppenclaw Model Reassessment Policy

Use this skill only inside a Puppenclaw reassessment run.

## Objective

Review prior assistant sessions after a model upgrade. Patch only concrete mistakes that are likely due to older-model misunderstanding or weaker performance.

## Patch Eligibility

Patch these categories when evidence is concrete:

- `security`: vulnerability, unsafe default, secret exposure, auth bypass, injection risk.
- `data_loss`: destructive behavior, migration risk, persistence bug.
- `correctness`: implementation contradicts the user's request or repo behavior.
- `functionality`: missing or broken user-visible feature.
- `obvious_old_model_mistake`: clear misread, hallucinated API, wrong file, or invalid assumption.

Do not patch these categories:

- `refactor_only`: cleaner shape but no material bug.
- `style_only`: naming, formatting, preference changes.
- `speculative`: possible improvement without evidence.
- `scope_expansion`: new feature not requested in the original session.

## Required Workflow

1. Reconstruct the user's original intent from the imported transcripts.
2. Inspect the current worktree before editing.
3. Identify candidate findings with evidence.
4. Apply only minimal, reviewable patches for patch-eligible findings.
5. Leave non-eligible findings in the report without code changes.
6. Keep the branch small enough to review manually.

## Required Report

Return Markdown with these sections:

- Executive judgment.
- Imported sessions reviewed.
- Findings by importance.
- Patches made.
- Findings intentionally not patched.
- Validation instructions and residual risk.

For each finding, include category, severity, confidence, evidence, changed files if patched, and why it is likely an older-model issue.
