# Puppenclaw

Puppenclaw is a native OpenClaw plugin that turns ACP-backed coding agents into a project-aware orchestration runtime.

Today it provides:
- named Claude Code or Codex ACP sessions
- project registration and context capture
- campaign templates for baseline work, literature review, ablations, and self-improvement loops
- artifact capture and approval gates
- optional daemon mode
- `oc2oc`-aware remote control paths for mediated delegation between OpenClaw peers

Puppenclaw does **not** yet implement a full typed orchestration transport inside `oc2oc`. The current `oc2oc` integration is conversation-mediated: remote assistants can delegate into Puppenclaw through bound and exposed `oc2oc` conversations, and Puppenclaw then runs work locally on the target node.

## What Works Now

- Local orchestration on one OpenClaw instance
- Daemon-backed orchestration over the local HTTP daemon
- Claude Code / Codex ACP session management
- Project context sync into reusable bundles
- Campaign templates:
  - `literature_review`
  - `baseline_from_scratch`
  - `ablation_campaign`
  - `self_improvement_loop`
  - `custom`
- Approval gating and resume
- Artifact listing and retention pruning
- Research-command delegation via `orchestration.gptResearcherCommand`
- `oc2oc`-mediated remote `/puppenclaw` command flow when the remote conversation is explicitly bound and exposed

## What This Repo Contains

This is a source repository.

Checked-in source:
- `index.ts`
- `src/**`
- `test/**`
- `skills/**`
- `scripts/sync-manifest.mts`
- `openclaw.plugin.json`

Generated at build time:
- `dist/**`

If you install from the repo path, run `npm run build` first. `dist/` is not meant to be committed.

## Prerequisites

- Node `>=22.13`
- npm
- an OpenClaw installation on the machine where the plugin will run
- working ACP adapter commands for the agents you plan to use

Default ACP adapter commands:
- Claude: `npx -y @zed-industries/claude-agent-acp`
- Codex: `npx @zed-industries/codex-acp`

Puppenclaw does not log you into model providers for you. Make sure the ACP adapter you plan to use already works on that machine before blaming Puppenclaw.

## Install From This Repo

From a clean checkout:

```bash
cd /absolute/path/to/puppenclaw
npm install
npm run build
openclaw plugins install /absolute/path/to/puppenclaw
```

Then restart the OpenClaw gateway.

This path is the one a later Codex session should use when bootstrapping from source.

## Install From a Packed Tarball

If you want a release-style artifact instead of installing from the repo path:

```bash
cd /absolute/path/to/puppenclaw
npm install
npm run build
npm pack
openclaw plugins install /absolute/path/to/puppenclaw/puppenclaw-openclaw-plugin-0.1.0.tgz
```

Use the actual tarball name produced by `npm pack`.

## Development Verification

```bash
cd /absolute/path/to/puppenclaw
npm install
npm run verify
```

That runs manifest sync, build, typecheck, and tests.

## Configuration

Configure Puppenclaw under `plugins.entries.puppenclaw.config`.

Minimal local mode:

```json
{
  "plugins": {
    "entries": {
      "puppenclaw": {
        "enabled": true,
        "config": {
          "backend": "local",
          "defaultAgent": "codex",
          "permissionMode": "approve-reads",
          "maxSessions": 5,
          "sessionTtlMinutes": 60,
          "streamOutput": true,
          "agentCommands": {
            "claude": "npx -y @zed-industries/claude-agent-acp",
            "codex": "npx @zed-industries/codex-acp"
          },
          "mcpServers": {},
          "orchestration": {
            "enabled": true,
            "maxCampaigns": 32,
            "artifactRetentionHours": 336,
            "allowLocalCommandExecution": true,
            "defaultProjectRoot": "/absolute/path/to/workspaces",
            "localWorker": {
              "id": "local",
              "label": "Local Worker",
              "labels": ["local"],
              "projectRoots": ["/absolute/path/to/workspaces"]
            }
          },
          "remoteControl": {
            "mediated": {
              "enabled": true
            },
            "purePipe": {
              "enabled": false,
              "allowFrom": [],
              "allowedAgents": []
            },
            "requireConversationBinding": true
          }
        }
      }
    }
  }
}
```

Daemon mode:

```json
{
  "plugins": {
    "entries": {
      "puppenclaw": {
        "enabled": true,
        "config": {
          "backend": "daemon",
          "daemonUrl": "http://127.0.0.1:18795",
          "defaultAgent": "codex",
          "permissionMode": "approve-reads",
          "streamOutput": true,
          "agentCommands": {
            "claude": "npx -y @zed-industries/claude-agent-acp",
            "codex": "npx @zed-industries/codex-acp"
          },
          "orchestration": {
            "enabled": true,
            "maxCampaigns": 32,
            "artifactRetentionHours": 336,
            "allowLocalCommandExecution": true,
            "defaultProjectRoot": "/absolute/path/to/workspaces",
            "localWorker": {
              "id": "local",
              "label": "Local Worker",
              "labels": ["local"],
              "projectRoots": ["/absolute/path/to/workspaces"]
            }
          }
        }
      }
    }
  }
}
```

### Config Notes

- `backend`
  - `local`: plugin process talks to ACP adapters directly
  - `daemon`: plugin talks to a standalone Puppenclaw HTTP daemon
- `orchestration.maxCampaigns`
  - maximum number of active campaigns in `draft`, `running`, or `waiting_approval`
- `orchestration.artifactRetentionHours`
  - old artifacts are pruned on runtime access
- `orchestration.defaultProjectRoot`
  - base directory used to resolve relative `project.rootDir` values
- `orchestration.allowLocalCommandExecution`
  - required for `command` steps and built-in evaluation/experiment commands
- `orchestration.gptResearcherCommand`
  - optional shell command for `research` steps
  - Puppenclaw sends the step prompt to stdin
  - Puppenclaw expects dossier text on stdout
  - environment variables exposed:
    - `PUPPENCLAW_PROJECT_ID`
    - `PUPPENCLAW_PROJECT_NAME`
    - `PUPPENCLAW_PROJECT_ROOT`
    - `PUPPENCLAW_CAMPAIGN_ID`
    - `PUPPENCLAW_CAMPAIGN_NAME`
    - `PUPPENCLAW_STEP_ID`
    - `PUPPENCLAW_STEP_TITLE`
    - `PUPPENCLAW_TASK`

Example research-command config:

```json
{
  "plugins": {
    "entries": {
      "puppenclaw": {
        "enabled": true,
        "config": {
          "backend": "local",
          "orchestration": {
            "gptResearcherCommand": "python /absolute/path/to/research-wrapper.py"
          }
        }
      }
    }
  }
}
```

## Running the Daemon

If you use `backend: "daemon"`, start the daemon separately after the repo is built:

```bash
cd /absolute/path/to/puppenclaw
npm run build
node dist/daemon/cli.js start --host 127.0.0.1 --port 18795 --data-dir /absolute/path/to/puppenclaw-state
```

Check health:

```bash
node dist/daemon/cli.js status --host 127.0.0.1 --port 18795
```

Stop it:

```bash
node dist/daemon/cli.js stop --host 127.0.0.1 --port 18795
```

## OpenClaw Usage Surfaces

Puppenclaw exposes three main surfaces:

1. Agent tools
- `puppenclaw_project_create`
- `puppenclaw_worker_register`
- `puppenclaw_context_sync`
- `puppenclaw_campaign_start`
- `puppenclaw_campaign_status`
- `puppenclaw_artifacts`
- `puppenclaw_campaign_approve`
- `puppenclaw_campaign_cancel`

2. Raw ACP session tools
- `puppenclaw_start`
- `puppenclaw_send`
- `puppenclaw_status`
- `puppenclaw_stop`
- `puppenclaw_resume`
- `puppenclaw_fork`
- `puppenclaw_cost`

3. `/puppenclaw` command
- mirrors the same behavior for deterministic command-style control

Gateway methods:
- `puppenclaw.projectCreate`
- `puppenclaw.workerRegister`
- `puppenclaw.contextSync`
- `puppenclaw.campaignRun`
- `puppenclaw.campaignStatus`
- `puppenclaw.artifacts`
- `puppenclaw.campaignApprove`
- `puppenclaw.campaignCancel`

## Quick Start: Local Orchestration

These are the exact steps a future Codex session can follow.

1. Create and install the plugin

```bash
cd /absolute/path/to/puppenclaw
npm install
npm run build
openclaw plugins install /absolute/path/to/puppenclaw
```

2. Restart the gateway

3. Configure the plugin in OpenClaw with at least:
- `backend`
- `defaultAgent`
- `agentCommands`
- `orchestration.defaultProjectRoot`

4. In an OpenClaw conversation, create the project

```text
/puppenclaw project {"name":"demo-project","rootDir":"demo-project","description":"Main repo"}
```

Because `rootDir` is relative here, Puppenclaw resolves it under `orchestration.defaultProjectRoot`.

5. Register or confirm the local worker

```text
/puppenclaw worker {"id":"local","label":"Local Worker","labels":["local"],"projectRoots":["/absolute/path/to/workspaces"]}
```

6. Sync context

```text
/puppenclaw sync {"projectId":"demo-project","includeFiles":["AGENTS.md","README.md"],"memoryText":"Use npm, run tests, keep code terse."}
```

7. Run a baseline campaign

```text
/puppenclaw campaign {"projectId":"demo-project","workerId":"local","name":"baseline","template":"baseline_from_scratch","task":"Implement the first working baseline for this repo.","evaluationCommand":"npm test"}
```

8. Inspect status

```text
/puppenclaw campaign-status {"projectId":"demo-project"}
```

9. Inspect artifacts

```text
/puppenclaw artifacts {"projectId":"demo-project"}
```

10. If the campaign paused for approval, resume it

```text
/puppenclaw approve {"campaignId":"camp-..."}
```

## Campaign Templates

### `literature_review`

Use for citation-conscious research or landscape mapping.

Behavior:
- by default, runs as an ACP `research` step
- if `orchestration.gptResearcherCommand` is configured, Puppenclaw runs that command instead and stores stdout as a `research-dossier` artifact

### `baseline_from_scratch`

Use for:
- plan
- implement
- optionally evaluate with `evaluationCommand`

### `ablation_campaign`

Use when you already know the concrete experiment commands.

Example:

```text
/puppenclaw campaign {"projectId":"demo-project","workerId":"local","name":"ablation-1","template":"ablation_campaign","task":"Compare prompt variants.","experimentCommands":["python run_a.py","python run_b.py"]}
```

### `self_improvement_loop`

Repeats:
- planning
- implementation
- optional evaluation
- review

Control loop size with `iterations`.

### `custom`

Use only when the built-in templates are not the right fit.

Example:

```text
/puppenclaw campaign {"projectId":"demo-project","workerId":"local","name":"custom-run","template":"custom","steps":[{"title":"Design","kind":"plan","executor":"acp","instruction":"Design the next phase."},{"title":"Run tests","kind":"eval","executor":"command","command":"npm test"}]}
```

## Raw ACP Session Control

Raw sessions still exist and are useful for admin or debugging work.

Examples:

```text
/puppenclaw start {"agent":"codex","name":"api-refactor","directory":".","task":"Implement the server side."}
/puppenclaw send {"name":"api-refactor","message":"Continue and run tests.","stream":true}
/puppenclaw status {}
/puppenclaw stop {"name":"api-refactor"}
```

Use the orchestration surface first when the work is project-shaped. Use raw sessions when the operator explicitly wants direct ACP control.

## oc2oc Integration

Current state:
- Puppenclaw recognizes `oc2oc` as a remote channel
- mediated remote control is supported
- deterministic pure-pipe control is supported only when explicitly enabled and exposed
- full typed Puppenclaw-over-`oc2oc` orchestration transport is not yet implemented

Remote control safety gates:
- `remoteControl.requireConversationBinding`
- `/puppenclaw bind`
- `/puppenclaw expose {"agents":["codex"],"allowPurePipe":true}`

Example remote setup flow inside an `oc2oc` conversation:

```text
/puppenclaw bind
/puppenclaw expose {"agents":["codex"],"allowPurePipe":true}
/puppenclaw campaign {"projectId":"remote-project","workerId":"local","name":"baseline","template":"baseline_from_scratch","task":"Implement the worker baseline.","evaluationCommand":"npm test"}
```

## Troubleshooting

### `Project root does not exist`

- Check `orchestration.defaultProjectRoot`
- Check whether `rootDir` was meant to be absolute or relative

### `Worker ... is not allowed to operate on ...`

- Expand `worker.projectRoots`
- Register the worker again with the correct allowed roots

### `Worker ... does not support command execution`

- Either enable `orchestration.allowLocalCommandExecution`
- Or register the worker with `executors: ["acp", "command"]`
- Or use a campaign that does not rely on command steps

### `Puppenclaw daemon is unreachable`

- Start the daemon
- Verify `daemonUrl`
- Run `node dist/daemon/cli.js status --host ... --port ...`

### ACP adapter starts fail

- Verify the configured `agentCommands` work outside Puppenclaw
- Verify provider authentication for the ACP adapter
- Keep in mind Puppenclaw does not configure provider auth on your behalf

## Development

```bash
npm install
npm run build
npm run verify
```

Useful source files:
- `src/orchestrator/runtime.ts`
- `src/orchestrator/store.ts`
- `src/plugin/service.ts`
- `src/plugin/tools.ts`
- `src/plugin/commands.ts`
- `src/plugin/gateway-methods.ts`

## License

MIT
