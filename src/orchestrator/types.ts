import type {
  AgentKind,
  CampaignState,
  CampaignTemplate,
  EffortLevel,
  OrchestrationExecutor,
  OrchestrationStepKind,
  PermissionMode,
  PlanningProfile,
  RunState,
  WorkerManifestInput
} from "../shared/types.js";

export type ProjectRecord = {
  id: string;
  name: string;
  rootDir: string;
  description?: string;
  defaultAgent?: AgentKind;
  fusionPreferredAgent?: AgentKind;
  planningProfile?: PlanningProfile;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  model?: string;
  createdAt: string;
  updatedAt: string;
  lastContextSyncAt?: string;
};

export type WorkerRecord = WorkerManifestInput & {
  createdAt: string;
  updatedAt: string;
};

export type ProjectContextBundle = {
  projectId: string;
  projectName: string;
  rootDir: string;
  createdAt: string;
  includeFiles: Array<{
    path: string;
    resolvedPath: string;
    bytes: number;
    truncated: boolean;
  }>;
  notes?: string;
  memoryText?: string;
  promptText: string;
};

export type CampaignStepRecord = {
  id: string;
  title: string;
  kind: OrchestrationStepKind;
  executor: OrchestrationExecutor;
  instruction?: string;
  command?: string;
  contextFiles: string[];
  approvalRequired: boolean;
  agent?: AgentKind;
  phaseGroup?: string;
  sessionScope?: "campaign" | "step";
  workingDirectory?: string;
  env: Record<string, string>;
  timeoutMs?: number;
  retryLimit: number;
  fusion?: FusionStepConfig;
};

export type FusionCandidate = Extract<AgentKind, "claude" | "codex">;

export type FusionStepConfig = {
  role: "implementation" | "candidate_eval" | "peer_review" | "external_arbiter" | "merge";
  candidate?: FusionCandidate;
  targetCandidate?: FusionCandidate;
};

export type FusionWorktreeRecord = {
  agent: FusionCandidate;
  path: string;
  branch: string;
  baseRef: string;
  baseCommit: string;
};

export type FusionCampaignRecord = {
  baseRef: string;
  baseCommit: string;
  preferredAgent: FusionCandidate;
  useExternalArbiter: boolean;
  bundleArtifactId: string;
  bundleHash: string;
  worktrees: Record<FusionCandidate, FusionWorktreeRecord> & {
    merged: FusionWorktreeRecord;
  };
  dossierArtifactId?: string;
  externalArbiterArtifactId?: string;
};

export type CampaignSpecRecord = {
  id: string;
  projectId: string;
  workerId: string;
  name: string;
  template: CampaignTemplate;
  task?: string;
  evaluationCommand?: string;
  experimentCommands: string[];
  experimentParallelism: number;
  iterations: number;
  steps: CampaignStepRecord[];
  acpSessionName?: string;
  currentStepIndex: number;
  currentRunId?: string;
  waitingApprovalStepId?: string;
  lastError?: string;
  lastProgressAt: string;
  createdAt: string;
  updatedAt: string;
  state: CampaignState;
  fusion?: FusionCampaignRecord;
};

export type RunRecord = {
  id: string;
  campaignId: string;
  projectId: string;
  workerId: string;
  stepId: string;
  stepTitle: string;
  stepIndex: number;
  kind: OrchestrationStepKind;
  executor: OrchestrationExecutor;
  state: RunState;
  startedAt: string;
  updatedAt: string;
  lastProgressAt: string;
  finishedAt?: string;
  summary?: string;
  outputText?: string;
  exitCode?: number;
  command?: string;
  sessionName?: string;
  attempts: number;
  failureCode?: string;
  failureCategory?: "timeout" | "execution" | "validation" | "unknown";
};

export type ArtifactFileRecord = {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
};

export type ArtifactRecord = {
  id: string;
  projectId: string;
  campaignId?: string;
  runId?: string;
  stepId?: string;
  siteId: string;
  kind:
    | "context"
    | "report"
    | "command-output"
    | "research-dossier"
    | "fusion-bundle"
    | "implementation-memo"
    | "peer-review"
    | "fusion-dossier"
    | "merge-summary"
    | "candidate-diff";
  title: string;
  summary?: string;
  relativePath: string;
  createdAt: string;
  sizeBytes: number;
  sha256: string;
  files?: ArtifactFileRecord[];
};

export type CampaignProgressSnapshot = {
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  currentStepIndex: number;
  experimentParallelism: number;
  currentStepId?: string;
  currentStepTitle?: string;
  currentRunId?: string;
  lastProgressAt: string;
};

export type CampaignStatusSnapshot = {
  campaign: CampaignSpecRecord;
  project: ProjectRecord | null;
  worker: WorkerRecord | null;
  runs: RunRecord[];
  artifacts: ArtifactRecord[];
  progress: CampaignProgressSnapshot;
};

export interface IOrchestrator {
  createProject(params: import("../shared/types.js").ProjectCreateParams): Promise<import("../shared/types.js").ToolResult>;
  registerWorker(params: import("../shared/types.js").WorkerManifestInput): Promise<import("../shared/types.js").ToolResult>;
  syncContext(params: import("../shared/types.js").ContextSyncParams): Promise<import("../shared/types.js").ToolResult>;
  runCampaign(params: import("../shared/types.js").CampaignRunParams): Promise<import("../shared/types.js").ToolResult>;
  status(params: import("../shared/types.js").CampaignStatusParams): Promise<import("../shared/types.js").ToolResult>;
  listArtifacts(params: import("../shared/types.js").ArtifactListParams): Promise<import("../shared/types.js").ToolResult>;
  approve(params: import("../shared/types.js").CampaignActionParams): Promise<import("../shared/types.js").ToolResult>;
  cancel(params: import("../shared/types.js").CampaignActionParams): Promise<import("../shared/types.js").ToolResult>;
  siteStatus(params?: import("../shared/types.js").SiteStatusParams): Promise<import("../shared/types.js").ToolResult>;
  logs(params: import("../shared/types.js").LogsParams): Promise<import("../shared/types.js").ToolResult>;
}
