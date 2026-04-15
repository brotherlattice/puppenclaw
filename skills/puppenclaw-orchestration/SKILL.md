---
name: puppenclaw-orchestration
description: Run project-aware Puppenclaw orchestration campaigns, use raw ACP sessions only when needed, and handle oc2oc-mediated delegation safely.
user-invocable: false
metadata:
  openclaw:
    requires:
      plugins: ["puppenclaw"]
---

# Puppenclaw Orchestration Policy

## Use Puppenclaw when

- The user wants project-aware orchestration, not just a single coding turn.
- The task needs repo context capture, multi-step execution, approvals, or artifacts.
- The request is a research, baseline, ablation, or self-improvement workflow.
- The request comes through `oc2oc` and should be mediated into a remote worker flow.

## Prefer orchestration primitives first

- Prefer:
  - `puppenclaw_project_create`
  - `puppenclaw_worker_register`
  - `puppenclaw_context_sync`
  - `puppenclaw_campaign_start`
  - `puppenclaw_campaign_status`
  - `puppenclaw_artifacts`
  - `puppenclaw_campaign_approve`
  - `puppenclaw_campaign_cancel`
- Create or reuse a project before running a campaign.
- Store project defaults when they are stable:
  - `defaultAgent`
  - `planningProfile`
  - `permissionMode`
  - `effort`
  - `model`
- Sync `AGENTS.md`, `README.md`, small design notes, and other high-signal files into context first.
- Use named workers with constrained project roots and explicit capabilities.

## High-performance coding orchestration

- Use OpenClaw as the orchestrator, not just a transport pipe into Codex or Claude.
- Refine vague ideas before starting ACP execution.
- Produce a detailed execution brief before the backend run:
  - goal
  - scope and non-scope
  - constraints
  - architecture direction
  - files or systems likely to change
  - tests and validation
  - explicit decision boundaries that should return to the human
- Prefer `planningProfile: "deep"` for full-project implementation work.
- Use `planningProfile: "quick"` for smaller but still multi-file implementation loops.
- Use `planningProfile: "off"` only when requirements are already explicit and low-risk.
- Prefer backend-specific executor skills:
  - `codex-plan-executor`
  - `claude-code-plan-executor`
- Use `project-refinement` before execution when the request is still underspecified.
- Use `implementation-review-gate` to decide whether the human must be brought back into the loop.

## Campaign selection

- Prefer `baseline_from_scratch` for initial implementation loops.
- Prefer `literature_review` for citation-conscious research dossiers.
- Prefer `ablation_campaign` when the operator already has concrete experiment commands.
- Prefer `self_improvement_loop` when iterative plan -> code -> eval -> review cycles are desired.
- Use `custom` only when the built-in templates do not fit.

## Raw session fallback

- Use raw session tools only when orchestration is too heavy or the operator explicitly wants direct ACP control.
- Reuse an existing session for the same `agent + directory` before starting a new one.
- Prefer `agent: "codex"` for Codex-oriented coding loops.
- Prefer `agent: "claude"` when the operator explicitly wants Claude Code behavior.
- If using raw sessions for substantial work, still inject a planning-first brief rather than forwarding raw user text.

## oc2oc-mediated control

- For remote `oc2oc` work, keep the remote assistant in control and treat Puppenclaw as the worker runtime.
- Use deterministic `/puppenclaw ...` commands only when the target conversation is explicitly bound and exposed for pure-pipe control.
- If no binding exists, request `/puppenclaw bind`.
- If the conversation is bound but not exposed, require `/puppenclaw expose`.
- Never assume pure-pipe remote control is allowed by default.

## When not to use Puppenclaw

- The user only wants an explanation, review, or architecture discussion.
- The task is a short inline snippet with no repo interaction.
- The user explicitly says not to run tools or not to touch the codebase.
