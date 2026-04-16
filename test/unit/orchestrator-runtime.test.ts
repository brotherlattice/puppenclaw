import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AcpxSessionManager } from "../../src/manager/acpx.js";
import { OrchestratorRuntime } from "../../src/orchestrator/runtime.js";
import { OrchestratorStore } from "../../src/orchestrator/store.js";
import { OutputRouter } from "../../src/plugin/output-router.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";
import { SessionStore } from "../../src/shared/store.js";

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Puppenclaw Test",
      GIT_AUTHOR_EMAIL: "puppenclaw@example.com",
      GIT_COMMITTER_NAME: "Puppenclaw Test",
      GIT_COMMITTER_EMAIL: "puppenclaw@example.com"
    }
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

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

  it("runs puppenfusion in isolated worktrees and produces fusion artifacts", async () => {
    const workspaceDir = await createTempDir("puppenclaw-fusion-");
    await writeFile(join(workspaceDir, "AGENTS.md"), "Follow the repo conventions.\n", "utf8");
    await writeFile(join(workspaceDir, "README.md"), "# Fusion Demo\n", "utf8");
    await writeFile(join(workspaceDir, "src.ts"), "export const value = 1;\n", "utf8");
    await writeFile(
      join(workspaceDir, ".gitignore"),
      [".orchestrator/", "state.json", ".fake-acpx-state/"].join("\n") + "\n",
      "utf8"
    );
    runGit(workspaceDir, ["init"]);
    runGit(workspaceDir, ["add", "."]);
    runGit(workspaceDir, ["commit", "-m", "initial"]);

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
        acpxCommand,
        defaultAgent: "claude"
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
        acpxCommand,
        defaultAgent: "claude"
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
      name: "fusion-project",
      rootDir: workspaceDir,
      defaultAgent: "claude",
      fusionPreferredAgent: "codex",
      planningProfile: "deep"
    });
    await runtime.syncContext({
      projectId: "fusion-project",
      includeFiles: ["AGENTS.md", "README.md"]
    });

    const campaign = await runtime.runCampaign({
      projectId: "fusion-project",
      workerId: "local",
      name: "fusion-run",
      template: "puppenfusion",
      task: "Implement the feature cleanly from the sealed bundle.",
      fusionPreferredAgent: "codex",
      evaluationCommand: "printf 'tests-ok\\n'",
      experimentCommands: [],
      experimentParallelism: 1,
      iterations: 1,
      steps: []
    });

    const startedDetails = campaign.details as {
      campaign: {
        id: string;
        state: string;
        template: string;
        waitingApprovalStepId?: string;
        fusion: {
          baseCommit: string;
          preferredAgent: string;
          bundleArtifactId: string;
          planArtifactId?: string;
          dossierArtifactId?: string;
          approvalState: string;
          currentPhase: string;
          worktrees: {
            codex: { path: string; branch: string };
            claude: { path: string; branch: string };
            merged: { path: string; branch: string };
          };
        };
      };
      runs: Array<{
        state: string;
        sessionName?: string;
        stepId: string;
      }>;
      artifacts: Array<{
        id: string;
        kind: string;
        stepId?: string;
        sha256: string;
      }>;
    };

    expect(startedDetails.campaign.template).toBe("puppenfusion");
    expect(startedDetails.campaign.state).toBe("waiting_approval");
    expect(startedDetails.campaign.waitingApprovalStepId).toBe("fusion-plan-approval");
    expect(startedDetails.campaign.fusion.preferredAgent).toBe("codex");
    expect(startedDetails.campaign.fusion.bundleArtifactId).toBeTruthy();
    expect(startedDetails.campaign.fusion.planArtifactId).toBeTruthy();
    expect(startedDetails.campaign.fusion.approvalState).toBe("waiting");
    expect(startedDetails.campaign.fusion.currentPhase).toBe("plan");
    expect(startedDetails.runs).toHaveLength(2);
    expect(startedDetails.runs.filter((run) => run.sessionName != null)).toHaveLength(2);
    expect(startedDetails.artifacts.filter((artifact) => artifact.kind === "fusion-plan-review")).toHaveLength(2);
    expect(startedDetails.artifacts.some((artifact) => artifact.kind === "fusion-plan")).toBe(true);

    const approved = await runtime.approve({
      campaignId: startedDetails.campaign.id
    });
    const details = approved.details as {
      campaign: {
        id: string;
        state: string;
        fusion: {
          baseCommit: string;
          preferredAgent: string;
          bundleArtifactId: string;
          planArtifactId?: string;
          dossierArtifactId?: string;
          approvalState: string;
          integrationState: string;
          resolverUsed: boolean;
          currentPhase: string;
          lastCompletedPhase?: string;
          candidateStates: Record<string, {
            status: string;
            candidateCommit?: string;
            validationArtifactId?: string;
          }>;
          phaseSummaries: Array<{
            phase: string;
          }>;
          events: Array<{
            type: string;
          }>;
          worktrees: {
            codex: { path: string; branch: string };
            claude: { path: string; branch: string };
            merged: { path: string; branch: string };
          };
        };
      };
      runs: Array<{
        state: string;
        sessionName?: string;
        stepId: string;
      }>;
      artifacts: Array<{
        id: string;
        kind: string;
        stepId?: string;
        sha256: string;
      }>;
    };

    expect(details.campaign.state).toBe("completed");
    expect(details.campaign.fusion.approvalState).toBe("approved");
    expect(details.campaign.fusion.integrationState).toBe("succeeded");
    expect(details.campaign.fusion.resolverUsed).toBe(false);
    expect(details.campaign.fusion.dossierArtifactId).toBeTruthy();
    expect(details.campaign.fusion.lastCompletedPhase).toBe("merged_eval");
    expect(details.runs.length).toBe(11);
    expect(details.runs.filter((run) => run.sessionName != null)).toHaveLength(6);
    expect(details.runs.some((run) => run.stepId.startsWith("fusion-merge-"))).toBe(false);
    expect(details.artifacts.some((artifact) => artifact.kind === "fusion-bundle")).toBe(true);
    expect(details.artifacts.filter((artifact) => artifact.kind === "fusion-plan-review")).toHaveLength(2);
    expect(details.artifacts.some((artifact) => artifact.kind === "fusion-plan")).toBe(true);
    expect(details.artifacts.filter((artifact) => artifact.kind === "implementation-memo")).toHaveLength(2);
    expect(details.artifacts.filter((artifact) => artifact.kind === "fusion-candidate")).toHaveLength(4);
    expect(details.artifacts.filter((artifact) => artifact.kind === "peer-review")).toHaveLength(2);
    expect(details.artifacts.some((artifact) => artifact.kind === "fusion-dossier")).toBe(true);
    expect(details.artifacts.some((artifact) => artifact.kind === "integration-report")).toBe(true);
    expect(details.artifacts.every((artifact) => artifact.sha256.length > 0)).toBe(true);

    const codexCommit = details.campaign.fusion.candidateStates.codex?.candidateCommit;
    const claudeCommit = details.campaign.fusion.candidateStates.claude?.candidateCommit;
    expect(codexCommit).toBeTruthy();
    expect(claudeCommit).toBeTruthy();
    expect(details.campaign.fusion.candidateStates.codex?.validationArtifactId).toBeTruthy();
    expect(details.campaign.fusion.candidateStates.claude?.validationArtifactId).toBeTruthy();
    expect(details.campaign.fusion.phaseSummaries.map((summary) => summary.phase).sort()).toEqual([
      "candidate_eval",
      "implement",
      "integration",
      "merged_eval",
      "peer_review",
      "plan"
    ]);
    expect(details.campaign.fusion.events.some((event) => event.type === "fusion_plan_ready")).toBe(true);
    expect(details.campaign.fusion.events.some((event) => event.type === "fusion_approved")).toBe(true);
    expect(details.campaign.fusion.events.some((event) => event.type === "fusion_integration_succeeded")).toBe(true);

    expect(runGit(details.campaign.fusion.worktrees.codex.path, ["rev-parse", "HEAD"])).toBe(codexCommit);
    expect(runGit(details.campaign.fusion.worktrees.claude.path, ["rev-parse", "HEAD"])).toBe(claudeCommit);
    const mergedHead = runGit(details.campaign.fusion.worktrees.merged.path, ["rev-parse", "HEAD"]);
    expect(mergedHead).not.toBe(details.campaign.fusion.baseCommit);
    runGit(details.campaign.fusion.worktrees.merged.path, [
      "merge-base",
      "--is-ancestor",
      codexCommit as string,
      mergedHead
    ]);
    runGit(details.campaign.fusion.worktrees.merged.path, [
      "merge-base",
      "--is-ancestor",
      claudeCommit as string,
      mergedHead
    ]);

    const sessions = sessionStore.listSessions();
    expect(sessions.filter((session) => session.name.includes("fusion-plan"))).toHaveLength(2);
    expect(sessions.filter((session) => session.name.includes("fusion-implement"))).toHaveLength(2);
    expect(sessions.filter((session) => session.name.includes("fusion-review"))).toHaveLength(2);
    expect(sessions.some((session) => session.name.includes("fusion-merge"))).toBe(false);
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
