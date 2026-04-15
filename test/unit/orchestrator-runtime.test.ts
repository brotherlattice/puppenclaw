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
      sessionStore,
      store: await OrchestratorStore.open(join(workspaceDir, ".orchestrator")),
      sessionManager: manager
    });

    const project = await runtime.createProject({
      name: "demo-project",
      rootDir: workspaceDir,
      defaultAgent: "codex",
      planningProfile: "deep",
      permissionMode: "approve-all",
      effort: "high",
      model: "openai/gpt-5.4"
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
      experimentParallelism: 1,
      iterations: 1,
      steps: []
    });

    const details = campaign.details as {
      campaign: {
        state: string;
      };
      runs: Array<{
        state: string;
        sessionName?: string;
      }>;
      artifacts: Array<{
        kind: string;
        sha256: string;
        siteId: string;
        stepId?: string;
        files?: Array<{
          sha256: string;
        }>;
      }>;
      progress: {
        completedSteps: number;
        experimentParallelism: number;
      };
    };
    expect(details.campaign.state).toBe("completed");
    expect(details.runs.some((run) => run.state === "completed")).toBe(true);
    expect(details.artifacts.some((artifact) => artifact.kind === "command-output")).toBe(true);
    expect(details.progress.completedSteps).toBe(details.runs.length);
    expect(details.progress.experimentParallelism).toBe(1);
    const commandArtifact = details.artifacts.find((artifact) => artifact.kind === "command-output");
    expect(commandArtifact?.sha256).toBeTruthy();
    expect(commandArtifact?.siteId).toBe("local");
    expect(commandArtifact?.stepId).toBeTruthy();
    expect(commandArtifact?.files?.[0]?.sha256).toBeTruthy();
    const projectArtifacts = await runtime.listArtifacts({
      projectId: "demo-project"
    });
    const artifactDetails = projectArtifacts.details as {
      artifacts: Array<{
        kind: string;
        sha256: string;
      }>;
    };
    expect(artifactDetails.artifacts.some((artifact) => artifact.kind === "context")).toBe(true);
    expect(artifactDetails.artifacts.every((artifact) => artifact.sha256.length > 0)).toBe(true);

    const siteStatus = await runtime.siteStatus({
      verbose: true
    });
    const siteDetails = siteStatus.details as {
      siteId: string;
      sessions: {
        total: number;
        items?: Array<{
          name: string;
        }>;
      };
      campaigns: {
        total: number;
      };
      workers: Array<{
        id: string;
      }>;
    };
    expect(siteDetails.siteId).toBe("local");
    expect(siteDetails.sessions.total).toBeGreaterThanOrEqual(1);
    expect(siteDetails.campaigns.total).toBe(1);
    expect(siteDetails.workers.some((worker) => worker.id === "local")).toBe(true);

    const sessionName = details.runs.find((run) => run.sessionName != null)?.sessionName;
    expect(sessionName).toBeTruthy();
    const sessionLogs = await runtime.logs({
      sessionName: sessionName as string,
      limitChars: 2_000,
      follow: false
    });
    const sessionLogDetails = sessionLogs.details as {
      scope: string;
      text: string;
    };
    expect(sessionLogDetails.scope).toBe("session");
    expect(sessionLogDetails.text.length).toBeGreaterThan(0);

    const campaignLogs = await runtime.logs({
      campaignId: (campaign.details as { campaign: { id: string } }).campaign.id,
      limitChars: 2_000,
      follow: false
    });
    const campaignLogDetails = campaignLogs.details as {
      scope: string;
      entries: Array<{
        id: string;
      }>;
    };
    expect(campaignLogDetails.scope).toBe("campaign");
    expect(campaignLogDetails.entries.length).toBe(details.runs.length);

    const orchestratedSession = sessionStore.listSessions().find((session) => session.name === sessionName);
    expect(orchestratedSession?.agent).toBe("codex");
    expect(orchestratedSession?.planningProfile).toBe("deep");
    expect(orchestratedSession?.permissionMode).toBe("approve-all");
    expect(orchestratedSession?.effort).toBe("high");
    expect(orchestratedSession?.model).toBe("openai/gpt-5.4");
    expect(
      orchestratedSession?.transcript.some((entry) =>
        entry.role === "user" && entry.text.includes("deep planning pass first")
      )
    ).toBe(true);
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
      sessionStore: await SessionStore.open(workspaceDir),
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
      experimentParallelism: 1,
      iterations: 1,
      steps: [
        {
          title: "Get approval first",
          kind: "plan",
          executor: "acp",
          instruction: "Outline the next action.",
          approvalRequired: true,
          contextFiles: [],
          env: {},
          retryLimit: 0
        },
        {
          title: "Continue work",
          kind: "code",
          executor: "acp",
          instruction: "Continue after approval.",
          contextFiles: [],
          approvalRequired: false,
          env: {},
          retryLimit: 0
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
      sessionStore,
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
      experimentParallelism: 1,
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
