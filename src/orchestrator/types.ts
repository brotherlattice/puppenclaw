import type {
  AgentKind,
  CampaignState,
  CampaignTemplate,
  OrchestrationExecutor,
  OrchestrationStepKind,
  RunState,
  WorkerManifestInput
} from "../shared/types.js";

export type ProjectRecord = {
  id: string;
  name: string;
  rootDir: string;
  description?: string;
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
  workingDirectory?: string;
  env: Record<string, string>;
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
  iterations: number;
  steps: CampaignStepRecord[];
  acpSessionName?: string;
  currentStepIndex: number;
  waitingApprovalStepId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  state: CampaignState;
};

export type RunRecord = {
  id: string;
  campaignId: string;
  projectId: string;
  workerId: string;
  stepId: string;
  stepTitle: string;
  kind: OrchestrationStepKind;
  executor: OrchestrationExecutor;
  state: RunState;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  summary?: string;
  outputText?: string;
  exitCode?: number;
  command?: string;
  sessionName?: string;
};

export type ArtifactRecord = {
  id: string;
  projectId: string;
  campaignId?: string;
  runId?: string;
  kind: "context" | "report" | "command-output" | "research-dossier";
  title: string;
  relativePath: string;
  createdAt: string;
  sizeBytes: number;
};

export type CampaignStatusSnapshot = {
  campaign: CampaignSpecRecord;
  project: ProjectRecord | null;
  worker: WorkerRecord | null;
  runs: RunRecord[];
  artifacts: ArtifactRecord[];
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
}
