import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AcpxSessionManager } from "../../src/manager/acpx.js";
import { OrchestratorRuntime } from "../../src/orchestrator/runtime.js";
import { OrchestratorStore } from "../../src/orchestrator/store.js";
import { OutputRouter } from "../../src/plugin/output-router.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";
import { SessionStore } from "../../src/shared/store.js";

describe("OrchestratorRuntime", () => {
  it("creates projects, syncs context, and runs a baseline campaign", async () => {
    const workspaceDir = await createTempDir("puppenclaw-orch-");
    await writeFile(join(workspaceDir, "AGENTS.md"), "Follow the repo conventions.\n", "utf8");
    await writeFile(join(workspaceDir, "README.md"), "# Demo\n", "utf8");

    const acpxCommand = await resolveFakeAcpxCommand();
    const sessionStore = await SessionStore.open(workspaceDir);
    const outputRouter = new OutputRouter({
      info() {},
      warn() {},
      error() {},
      debug() {}
    });
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store: sessionStore,
      outputRouter
    });
    const runtime = new OrchestratorRuntime({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store: await OrchestratorStore.open(join(workspaceDir, ".orchestrator")),
      sessionManager: manager
    });

    const project = await runtime.createProject({
      name: "demo-project",
      rootDir: workspaceDir
    });
    expect(project.content[0]?.text).toContain("Created project");

    const sync = await runtime.syncContext({
      projectId: "demo-project",
      includeFiles: ["AGENTS.md", "README.md"],
      memoryText: "Remember the local build commands."
    });
    expect(sync.content[0]?.text).toContain("Synchronized context");

    const campaign = await runtime.runCampaign({
      projectId: "demo-project",
      workerId: "local",
      name: "baseline",
      template: "baseline_from_scratch",
      task: "Implement the first baseline for this project.",
      evaluationCommand: "printf 'tests-ok\\n'",
      experimentCommands: [],
      iterations: 1,
      steps: []
    });

    const details = campaign.details as {
      campaign: {
        state: string;
      };
      runs: Array<{
        state: string;
      }>;
      artifacts: Array<{
        kind: string;
      }>;
    };
    expect(details.campaign.state).toBe("completed");
    expect(details.runs.some((run) => run.state === "completed")).toBe(true);
    expect(details.artifacts.some((artifact) => artifact.kind === "command-output")).toBe(true);
    const projectArtifacts = await runtime.listArtifacts({
      projectId: "demo-project"
    });
    const artifactDetails = projectArtifacts.details as {
      artifacts: Array<{
        kind: string;
      }>;
    };
    expect(artifactDetails.artifacts.some((artifact) => artifact.kind === "context")).toBe(true);
  });

  it("pauses for approval and resumes when approved", async () => {
    const workspaceDir = await createTempDir("puppenclaw-orch-approval-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store: await SessionStore.open(workspaceDir),
      outputRouter: new OutputRouter({
        info() {},
        warn() {},
        error() {},
        debug() {}
      })
    });
    const runtime = new OrchestratorRuntime({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store: await OrchestratorStore.open(join(workspaceDir, ".orchestrator")),
      sessionManager: manager
    });

    await runtime.createProject({
      name: "approval-project",
      rootDir: workspaceDir
    });

    const started = await runtime.runCampaign({
      projectId: "approval-project",
      workerId: "local",
      name: "gated",
      template: "custom",
      experimentCommands: [],
      iterations: 1,
      steps: [
        {
          title: "Get approval first",
          kind: "plan",
          executor: "acp",
          instruction: "Outline the next action.",
          approvalRequired: true,
          contextFiles: [],
          env: {}
        },
        {
          title: "Continue work",
          kind: "code",
          executor: "acp",
          instruction: "Continue after approval.",
          contextFiles: [],
          approvalRequired: false,
          env: {}
        }
      ]
    });
    const startedDetails = started.details as {
      campaign: {
        id: string;
        state: string;
        waitingApprovalStepId?: string;
      };
    };
    expect(startedDetails.campaign.state).toBe("waiting_approval");
    expect(startedDetails.campaign.waitingApprovalStepId).toBeTruthy();

    const approved = await runtime.approve({
      campaignId: startedDetails.campaign.id
    });
    const approvedDetails = approved.details as {
      campaign: {
        state: string;
      };
    };
    expect(approvedDetails.campaign.state).toBe("completed");
  });

  it("uses the configured research command for literature-review campaigns", async () => {
    const workspaceDir = await createTempDir("puppenclaw-orch-research-");
    const sessionStore = await SessionStore.open(workspaceDir);
    const outputRouter = new OutputRouter({
      info() {},
      warn() {},
      error() {},
      debug() {}
    });
    const manager = new AcpxSessionManager({
      config: makeConfig({
        orchestration: {
          gptResearcherCommand: "cat >/dev/null; printf 'research dossier ready\\n'"
        }
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store: sessionStore,
      outputRouter
    });
    const runtime = new OrchestratorRuntime({
      config: makeConfig({
        orchestration: {
          gptResearcherCommand: "cat >/dev/null; printf 'research dossier ready\\n'"
        }
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store: await OrchestratorStore.open(join(workspaceDir, ".orchestrator")),
      sessionManager: manager
    });

    await runtime.createProject({
      name: "research-project",
      rootDir: workspaceDir
    });

    const campaign = await runtime.runCampaign({
      projectId: "research-project",
      workerId: "local",
      name: "literature-review",
      template: "literature_review",
      task: "Map the current project constraints and prior art.",
      experimentCommands: [],
      iterations: 1,
      steps: []
    });
    const details = campaign.details as {
      campaign: {
        state: string;
      };
      artifacts: Array<{
        kind: string;
      }>;
    };
    expect(details.campaign.state).toBe("completed");
    expect(details.artifacts.some((artifact) => artifact.kind === "research-dossier")).toBe(true);
    expect(sessionStore.listSessions()).toHaveLength(0);
  });
});
