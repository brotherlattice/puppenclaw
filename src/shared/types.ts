import type { z } from "zod";

import type {
  agentKindZod,
  backendZod,
  costParamsZod,
  effortLevelZod,
  exposeParamsZod,
  forkParamsZod,
  mcpServerConfigZod,
  permissionModeZod,
  pluginConfigZod,
  remoteControlConfigZod,
  resumeParamsZod,
  sendParamsZod,
  startParamsZod,
  statusParamsZod,
  stopParamsZod
} from "./schema.js";

export type AgentKind = z.infer<typeof agentKindZod>;
export type BackendMode = z.infer<typeof backendZod>;
export type PermissionMode = z.infer<typeof permissionModeZod>;
export type EffortLevel = z.infer<typeof effortLevelZod>;
export type PluginConfig = z.input<typeof pluginConfigZod>;
export type ParsedPluginConfig = z.output<typeof pluginConfigZod>;
export type McpServerConfig = z.infer<typeof mcpServerConfigZod>;
export type RemoteControlConfig = z.infer<typeof remoteControlConfigZod>;
export type StartParams = z.infer<typeof startParamsZod>;
export type SendParams = z.infer<typeof sendParamsZod>;
export type StopParams = z.infer<typeof stopParamsZod>;
export type ResumeParams = z.infer<typeof resumeParamsZod>;
export type ForkParams = z.infer<typeof forkParamsZod>;
export type StatusParams = z.infer<typeof statusParamsZod>;
export type CostParams = z.infer<typeof costParamsZod>;
export type ExposeParams = z.infer<typeof exposeParamsZod>;

export type ToolTextBlock = {
  type: "text";
  text: string;
};

export type ToolResult<TDetails = Record<string, unknown>> = {
  content: ToolTextBlock[];
  details: TDetails;
};

export type SessionState =
  | "idle"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "stopped";

export type TokenUsage = {
  used?: number;
  size?: number;
  input?: number;
  output?: number;
  cached?: number;
};

export type SessionTranscriptEntry = {
  role: "system" | "user" | "assistant" | "status";
  text: string;
  createdAt: string;
};

export type ContextFileEntry = {
  path: string;
  resolvedPath: string;
  bytes: number;
  truncated: boolean;
};

export type AcpxSessionHandle = {
  runtimeSessionName: string;
  cwd: string;
  agent: AgentKind;
  mode: "persistent";
};

export type SessionInfo = {
  name: string;
  agent: AgentKind;
  directory: string;
  state: SessionState;
  createdAt: string;
  lastActivity: string;
  permissionMode: PermissionMode;
  effort?: EffortLevel;
  model?: string;
  tokenUsage?: TokenUsage;
  pendingQuestion?: string;
  lastError?: string;
  warnings: string[];
  transcript: SessionTranscriptEntry[];
  handle?: AcpxSessionHandle;
  lastStopReason?: string;
  source?: SessionSourceInfo;
  origin?: ConversationScope;
};

export type ConversationScope = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  threadId?: string | number;
};

export type SessionSourceInfo = {
  kind: "tool" | "command" | "daemon";
  channel?: string;
  requesterSenderId?: string;
  bindingId?: string;
};

export type ExposureRecord = {
  bindingId: string;
  conversation: ConversationScope;
  allowPurePipe: boolean;
  allowedAgents: AgentKind[];
  updatedAt: string;
};

export type StoredState = {
  version: 1;
  sessions: Record<string, SessionInfo>;
  exposures: Record<string, ExposureRecord>;
};

export type PromptEvent =
  | {
      type: "text_delta";
      text: string;
      stream: "output" | "thought";
      tag?: string;
    }
  | {
      type: "tool_call";
      text: string;
      title: string;
      status?: string;
      tag?: string;
      toolCallId?: string;
    }
  | {
      type: "status";
      text: string;
      tag?: string;
      used?: number;
      size?: number;
    }
  | {
      type: "done";
      stopReason?: string;
    }
  | {
      type: "error";
      message: string;
      code?: string;
      retryable?: boolean;
    };

export type CommandParseResult =
  | {
      ok: true;
      verb: string;
      payloadText: string;
    }
  | {
      ok: false;
      message: string;
    };
