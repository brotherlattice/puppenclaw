---
name: puppenfusion-orchestrator
description: Run dual-backend Puppenfusion campaigns where Codex and Claude receive the same sealed brief, cross-review each other, and merge into one final candidate.
user-invocable: false
metadata:
  openclaw:
    requires:
      plugins: ["puppenclaw"]
---

# Puppenfusion Orchestrator

## Use Puppenfusion when

- The task is large enough that two independent implementations are worth the extra runtime.
- The operator wants Codex and Claude to start from the same brief instead of taking different instructions.
- The goal is to compare strengths, review weaknesses, and fuse the best ideas into one final implementation.
- The repo is local, git-backed, and clean enough to branch into isolated worktrees.

## Preconditions

- The project root must be a git repo.
- The git worktree must be clean before the campaign starts.
- Both Codex and Claude ACP backends must be available.
- Context should be synced first so both candidates receive the same high-signal bundle.

## Workflow

1. Build a strong task brief:
   - objective
   - scope
   - non-scope
   - constraints
   - architecture direction
   - validation plan
   - decision boundaries
2. Start `template: "puppenfusion"`.
3. Pin `fusionPreferredAgent` when the final merge backend matters.
4. Let both implementations run from the same sealed bundle.
5. Let fresh review sessions cross-review the two candidates.
6. Read the final fusion dossier before escalating to the human.
7. Bring the human back only if the dossier or merge pass flags a real decision boundary.

## Operator guidance

- Use `evaluationCommand` whenever the repo has a meaningful automated check.
- Use `useExternalArbiter: true` only when a real external arbiter command is configured.
- Prefer this template for high-value project work, not for short one-agent edits.
- Do not improvise a manual fusion flow with ad hoc raw ACP sessions if the campaign template already fits.

## Bad behavior

- Giving Codex and Claude different task briefs and calling it a fair fusion run.
- Reusing the original implementation sessions as reviewers.
- Starting a fusion run on a dirty repo.
- Letting the final merge backend float implicitly when the operator actually cares which one performs the merge.
