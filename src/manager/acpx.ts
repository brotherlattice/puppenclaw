import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";

import type { PluginLogger } from "openclaw/plugin-sdk/core";

import { SessionStore } from "../shared/store.js";
import {
  DEFAULT_ACPX_AGENT_COMMANDS,
  DEFAULT_MAX_SESSIONS
} from "../shared/schema.js";
import { ensureError, PuppenclawError } from "../shared/errors.js";
import { jsonToolResult, textToolResult } from "../shared/tool-results.js";
import type {
  AgentKind,
  CostParams,
  EffortLevel,
  ForkParams,
  ParsedPluginConfig,
  PermissionMode,
  PlanningProfile,
  PromptEvent,
  ResumeParams,
  SendParams,
  SessionInfo,
  SessionTranscriptEntry,
  StartParams,
  StatusParams,
  StopParams,
  ToolResult,
  TokenUsage
} from "../shared/types.js";
import { loadContextFiles, nowIso, summarizePromptEvents } from "../shared/utils.js";
import type { OutputRouter } from "../plugin/output-router.js";
import type { ISessionManager } from "./interface.js";

type JsonRecord = Record<string, unknown>;

type ControlCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

type RuntimeStatus = {
  exists: boolean;
  status?: string;
  raw?: JsonRecord | null;
};

type TurnResult = {
  output: string;
  question?: string;
  tokenUsage?: TokenUsage;
  warnings: string[];
  transcript: SessionTranscriptEntry[];
  state: SessionInfo["state"];
};

type SpawnCommand = {
  command: string;
  args: string[];
  shell: boolean;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asOptionalString(value: unknown): string | undefined {
  const trimmed = asTrimmedString(value);
  return trimmed.length > 0 ? trimmed : undefined;
}

function asOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toErrorRecord(event: JsonRecord | undefined): { code?: string; message: string } | null {
  if (event == null) {
    return null;
  }
  if (asTrimmedString(event.type) !== "error") {
    return null;
  }
  const code = asOptionalString(event.code);
  return {
    ...(code != null ? { code } : {}),
    message: asOptionalString(event.message) ?? "ACP runtime error"
  };
}

function isNoSessionStatus(event: JsonRecord | null): boolean {
  if (event == null) {
    return false;
  }
  const status = asTrimmedString(event.status).toLowerCase();
  if (status === "no-session") {
    return true;
  }
  const action = asTrimmedString(event.action).toLowerCase();
  return (
    action === "status_snapshot" &&
    asTrimmedString(event.summary).toLowerCase() === "no active session"
  );
}

function buildPermissionArgs(mode: PermissionMode): string[] {
  if (mode === "approve-all") {
    return ["--approve-all"];
  }
  if (mode === "deny-all") {
    return ["--deny-all"];
  }
  return ["--approve-reads"];
}

function parseJsonLines(value: string): JsonRecord[] {
  const events: JsonRecord[] = [];
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) {
        events.push(parsed);
      }
    } catch {
      // ignored intentionally
    }
  }
  return events;
}

function createTextDeltaEvent(input: {
  payload: JsonRecord;
  stream: "output" | "thought";
  tag?: string;
}): PromptEvent | null {
  const content = input.payload.content;
  if (isRecord(content)) {
    const text = asOptionalString(content.text);
    if (text != null) {
      return {
        type: "text_delta",
        text,
        stream: input.stream,
        ...(input.tag != null ? { tag: input.tag } : {})
      };
    }
  }
  const text = asOptionalString(input.payload.text) ?? asOptionalString(input.payload.content);
  if (text == null) {
    return null;
  }
  return {
    type: "text_delta",
    text,
    stream: input.stream,
    ...(input.tag != null ? { tag: input.tag } : {})
  };
}

function resolveStructuredPayload(parsed: JsonRecord): {
  type: string;
  payload: JsonRecord;
  tag?: string;
} {
  if (asTrimmedString(parsed.method) === "session/update" && isRecord(parsed.params)) {
    const update = parsed.params.update;
    if (isRecord(update)) {
      const tag = asOptionalString(update.sessionUpdate);
      return {
        type: tag ?? "",
        payload: update,
        ...(tag != null ? { tag } : {})
      };
    }
  }
  const sessionUpdate = asOptionalString(parsed.sessionUpdate);
  if (sessionUpdate != null) {
    return {
      type: sessionUpdate,
      payload: parsed,
      tag: sessionUpdate
    };
  }
  const tag = asOptionalString(parsed.tag);
  return {
    type: asTrimmedString(parsed.type),
    payload: parsed,
    ...(tag != null ? { tag } : {})
  };
}

function parsePromptEventLine(line: string): PromptEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const structured = resolveStructuredPayload(parsed);
    switch (structured.type) {
      case "text":
      case "agent_message_chunk":
        return createTextDeltaEvent({
          payload: structured.payload,
          stream: "output",
          ...(structured.tag != null ? { tag: structured.tag } : {})
        });
      case "thought":
      case "agent_thought_chunk":
        return createTextDeltaEvent({
          payload: structured.payload,
          stream: "thought",
          ...(structured.tag != null ? { tag: structured.tag } : {})
        });
      case "tool_call":
      case "tool_call_update": {
        const title = asOptionalString(structured.payload.title) ?? "tool call";
        const status = asOptionalString(structured.payload.status);
        const toolCallId = asOptionalString(structured.payload.toolCallId);
        return {
          type: "tool_call",
          text: status != null ? `${title} (${status})` : title,
          title,
          ...(status != null ? { status } : {}),
          ...(structured.tag != null ? { tag: structured.tag } : {}),
          ...(toolCallId != null ? { toolCallId } : {})
        };
      }
      case "usage_update": {
        const used = asOptionalFiniteNumber(structured.payload.used);
        const size = asOptionalFiniteNumber(structured.payload.size);
        return {
          type: "status",
          text:
            used != null && size != null ? `usage updated: ${used}/${size}` : "usage updated",
          ...(structured.tag != null ? { tag: structured.tag } : {}),
          ...(used != null ? { used } : {}),
          ...(size != null ? { size } : {})
        };
      }
      case "done":
        {
        const stopReason = asOptionalString(structured.payload.stopReason);
        return {
          type: "done",
          ...(stopReason != null ? { stopReason } : {})
        };
      }
      case "error":
        {
        const code = asOptionalString(structured.payload.code);
        return {
          type: "error",
          message: asOptionalString(structured.payload.message) ?? "ACP runtime error",
          ...(code != null ? { code } : {})
        };
      }
      default: {
        const statusText =
          asOptionalString(structured.payload.summary) ??
          asOptionalString(structured.payload.message) ??
          asOptionalString(structured.payload.update);
        if (statusText == null) {
          return null;
        }
        return {
          type: "status",
          text: statusText,
          ...(structured.tag != null ? { tag: structured.tag } : {})
        };
      }
    }
  } catch {
    return {
      type: "status",
      text: trimmed
    };
  }
}

function dedupeWarnings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function mergeTranscript(
  previous: readonly SessionTranscriptEntry[],
  additions: readonly SessionTranscriptEntry[]
): SessionTranscriptEntry[] {
  return [...previous, ...additions].slice(-200);
}

function resolveQuestionFromOutput(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) {
    return undefined;
  }
  const paragraphs = trimmed
    .split(/\n\s*\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const candidate = paragraphs.at(-1) ?? trimmed;
  if (/^(question|need input|user input)\s*[:\-]/iu.test(candidate)) {
    return candidate;
  }
  if (candidate.endsWith("?") && candidate.length <= 600) {
    return candidate;
  }
  return undefined;
}

function makeAssistantTranscript(text: string): SessionTranscriptEntry[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  return [
    {
      role: "assistant",
      text: trimmed,
      createdAt: nowIso()
    }
  ];
}

function splitCommandLine(input: string): string[] {
  const matches = input.match(/"([^"]*)"|'([^']*)'|[^\s]+/gu) ?? [];
  return matches.map((part) => {
    if (
      (part.startsWith("\"") && part.endsWith("\"")) ||
      (part.startsWith("'") && part.endsWith("'"))
    ) {
      return part.slice(1, -1);
    }
    return part;
  });
}

function shellQuote(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  return `'${value.replace(/'/gu, `'\"'\"'`)}'`;
}

function resolveSpawnCommand(commandText: string, args: string[]): SpawnCommand {
  const trimmed = commandText.trim();
  const parts = splitCommandLine(trimmed);
  if (parts.length === 0) {
    return {
      command: "acpx",
      args,
      shell: false
    };
  }
  if (parts.length !== 1 || parts[0] !== trimmed) {
    const suffix = args.map((value) => shellQuote(value)).join(" ");
    return {
      command: suffix.length > 0 ? `${trimmed} ${suffix}` : trimmed,
      args: [],
      shell: true
    };
  }
  return {
    command: parts[0],
    args: [...parts.slice(1), ...args],
    shell: false
  };
}

function makeUserTranscript(text: string): SessionTranscriptEntry[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  return [
    {
      role: "user",
      text: trimmed,
      createdAt: nowIso()
    }
  ];
}

export class AcpxSessionManager implements ISessionManager {
  constructor(
    private readonly deps: {
      config: ParsedPluginConfig;
      logger: PluginLogger;
      store: SessionStore;
      outputRouter: OutputRouter;
    }
  ) {}

  async start(params: StartParams): Promise<ToolResult> {
    const directory = resolvePath(params.directory);
    const now = nowIso();
    const existing = this.deps.store.getSession(params.name);
    if (existing != null) {
      if (existing.agent !== params.agent) {
        throw new PuppenclawError(
          "SESSION_CONFLICT",
          `Session ${params.name} already exists for agent ${existing.agent}.`
        );
      }
      if (resolvePath(existing.directory) !== directory) {
        throw new PuppenclawError(
          "SESSION_CONFLICT",
          `Session ${params.name} already points at ${existing.directory}.`
        );
      }
    } else {
      const activeCount = this.deps.store
        .listSessions()
        .filter((session) => !["failed", "stopped", "completed"].includes(session.state)).length;
      if (activeCount >= (this.deps.config.maxSessions || DEFAULT_MAX_SESSIONS)) {
        throw new PuppenclawError(
          "MAX_SESSIONS_REACHED",
          `Puppenclaw is already tracking ${activeCount} sessions.`
        );
      }
    }

    const session = existing ?? this.createSession({
      name: params.name,
      agent: params.agent,
      directory,
      permissionMode: params.permissionMode ?? this.deps.config.permissionMode,
      ...(params.effort != null ? { effort: params.effort } : {}),
      ...(params.planningProfile != null ? { planningProfile: params.planningProfile } : {}),
      ...(params.model != null ? { model: params.model } : {}),
      createdAt: now
    });

    const warnings = dedupeWarnings([
      ...session.warnings,
      ...this.resolveCapabilityWarnings({
        agent: params.agent,
        ...(params.model != null ? { model: params.model } : {}),
        ...(params.effort != null ? { effort: params.effort } : {}),
        ...(params.planningProfile != null ? { planningProfile: params.planningProfile } : {})
      })
    ]);

    await this.ensureRuntimeSession({
      name: params.name,
      agent: params.agent,
      directory
    });

    const context = await loadContextFiles(directory, params.contextFiles);
    const promptText = [
      this.buildPlanningPromptPrefix({
        agent: params.agent,
        ...(params.planningProfile ?? session.planningProfile
          ? { planningProfile: params.planningProfile ?? session.planningProfile }
          : {})
      }),
      params.task.trim(),
      context.promptText
    ]
      .filter(Boolean)
      .join("\n\n");
    const turn = await this.runTurn({
      session,
      promptText,
      permissionMode: session.permissionMode
    });

    const nextSession: SessionInfo = {
      ...session,
      state: turn.state,
      lastActivity: nowIso(),
      warnings: dedupeWarnings([...warnings, ...turn.warnings]),
      transcript: mergeTranscript(
        session.transcript,
        [...makeUserTranscript(promptText), ...turn.transcript]
      ),
      ...(turn.question != null ? { pendingQuestion: turn.question } : {}),
      ...(turn.state === "failed"
        ? { lastError: turn.output || session.lastError || "ACP turn failed." }
        : {}),
      ...(turn.tokenUsage != null
        ? { tokenUsage: turn.tokenUsage }
        : session.tokenUsage != null
          ? { tokenUsage: session.tokenUsage }
          : {}),
      handle: {
        runtimeSessionName: params.name,
        cwd: directory,
        agent: params.agent,
        mode: "persistent"
      }
    };

    await this.deps.store.upsertSession(nextSession);
    return textToolResult(`Started session ${params.name}.`, {
      session: nextSession,
      output: turn.output,
      contextFiles: context.files
    });
  }

  async send(params: SendParams): Promise<ToolResult> {
    const session = this.requireSession(params.name);
    const context = await loadContextFiles(session.directory, params.contextFiles);
    const prefix = params.ultrathink ? "Use a high-effort reasoning pass for this reply.\n\n" : "";
    const promptText = [prefix + params.message.trim(), context.promptText].filter(Boolean).join("\n\n");
    const turn = await this.runTurn({
      session,
      promptText,
      permissionMode: session.permissionMode
    });

    const nextSession: SessionInfo = {
      ...session,
      state: turn.state,
      lastActivity: nowIso(),
      warnings: dedupeWarnings([...session.warnings, ...turn.warnings]),
      transcript: mergeTranscript(session.transcript, [
        ...makeUserTranscript(promptText),
        ...turn.transcript
      ]),
      ...(turn.question != null ? { pendingQuestion: turn.question } : {}),
      ...(turn.state === "failed"
        ? { lastError: turn.output || session.lastError || "ACP turn failed." }
        : {}),
      ...(turn.tokenUsage != null
        ? { tokenUsage: turn.tokenUsage }
        : session.tokenUsage != null
          ? { tokenUsage: session.tokenUsage }
          : {})
    };

    await this.deps.store.upsertSession(nextSession);
    return textToolResult(`Updated session ${params.name}.`, {
      session: nextSession,
      output: turn.output,
      contextFiles: context.files
    });
  }

  async stop(params: StopParams): Promise<ToolResult> {
    const session = this.requireSession(params.name);
    await this.runControlCommand({
      args: this.buildVerbArgs(session.agent, session.directory, [
        "cancel",
        "--session",
        session.name
      ]),
      cwd: session.directory
    }).catch(() => {
      // best-effort cancel
    });

    const nextSession: SessionInfo = {
      ...session,
      state: "stopped",
      lastActivity: nowIso(),
      lastStopReason: "stopped by user"
    };
    await this.deps.store.upsertSession(nextSession);
    return textToolResult(`Stopped session ${params.name}.`, {
      session: nextSession
    });
  }

  async resume(params: ResumeParams): Promise<ToolResult> {
    const session = this.requireSession(params.name);
    await this.ensureRuntimeSession({
      name: session.name,
      agent: session.agent,
      directory: session.directory
    });
    const nextSession: SessionInfo = {
      ...session,
      state: "idle",
      lastActivity: nowIso()
    };
    await this.deps.store.upsertSession(nextSession);
    return textToolResult(`Resumed session ${params.name}.`, {
      session: nextSession
    });
  }

  async fork(params: ForkParams): Promise<ToolResult> {
    const source = this.requireSession(params.source);
    if (this.deps.store.getSession(params.target) != null) {
      throw new PuppenclawError(
        "SESSION_EXISTS",
        `Target session ${params.target} already exists.`
      );
    }
    const transcriptText = source.transcript
      .map((entry) => `${entry.role.toUpperCase()}: ${entry.text}`)
      .join("\n\n");
    const forkPrompt = [
      `This is a fork of session ${source.name}.`,
      "Treat the following transcript as prior context for the new branch.",
      transcriptText
    ].join("\n\n");

    const result = await this.start({
      agent: source.agent,
      name: params.target,
      directory: source.directory,
      task: forkPrompt,
      permissionMode: source.permissionMode,
      effort: params.effort ?? source.effort,
      planningProfile: source.planningProfile,
      model: params.model ?? source.model,
      contextFiles: []
    });
    return textToolResult(`Forked ${params.source} into ${params.target}.`, result.details);
  }

  async status(params: StatusParams = {}): Promise<ToolResult> {
    if (params.name == null) {
      return jsonToolResult(
        {
          sessions: this.deps.store.listSessions()
        },
        "Tracked Puppenclaw sessions"
      );
    }
    const session = this.requireSession(params.name);
    const runtimeStatus = await this.getRuntimeStatus({
      name: session.name,
      agent: session.agent,
      directory: session.directory
    });
    const details = {
      session,
      runtime: runtimeStatus
    };
    return jsonToolResult(details, `Status for ${params.name}`);
  }

  async cost(params: CostParams): Promise<ToolResult> {
    const session = this.requireSession(params.name);
    return textToolResult(`Usage for session ${params.name}.`, {
      name: session.name,
      tokenUsage: session.tokenUsage ?? null,
      pricing: null,
      note: "Puppenclaw records token counters when the ACP runtime emits them. It does not infer currency pricing."
    });
  }

  async gc(): Promise<void> {
    const now = Date.now();
    const ttlMs = this.deps.config.sessionTtlMinutes * 60_000;
    for (const session of this.deps.store.listSessions()) {
      if (!["failed", "completed", "stopped"].includes(session.state)) {
        continue;
      }
      const ageMs = now - Date.parse(session.lastActivity);
      if (!Number.isFinite(ageMs) || ageMs < ttlMs) {
        continue;
      }
      await this.runControlCommand({
        args: this.buildVerbArgs(session.agent, session.directory, [
          "sessions",
          "close",
          session.name
        ]),
        cwd: session.directory
      }).catch(() => {
        // best effort
      });
      await this.deps.store.removeSession(session.name);
      this.deps.outputRouter.clear(session.name);
    }
  }

  private createSession(params: {
    name: string;
    agent: AgentKind;
    directory: string;
    permissionMode: PermissionMode;
    effort?: EffortLevel;
    planningProfile?: PlanningProfile;
    model?: string;
    createdAt: string;
  }): SessionInfo {
    return {
      name: params.name,
      agent: params.agent,
      directory: params.directory,
      state: "idle",
      createdAt: params.createdAt,
      lastActivity: params.createdAt,
      permissionMode: params.permissionMode,
      ...(params.effort != null ? { effort: params.effort } : {}),
      ...(params.planningProfile != null ? { planningProfile: params.planningProfile } : {}),
      ...(params.model != null ? { model: params.model } : {}),
      warnings: [],
      transcript: [],
      handle: {
        runtimeSessionName: params.name,
        cwd: params.directory,
        agent: params.agent,
        mode: "persistent"
      }
    };
  }

  private requireSession(name: string): SessionInfo {
    const session = this.deps.store.getSession(name);
    if (session == null) {
      throw new PuppenclawError("NO_SESSION", `Unknown session ${name}.`);
    }
    return session;
  }

  private resolveCapabilityWarnings(params: {
    agent: AgentKind;
    model?: string;
    effort?: EffortLevel;
    planningProfile?: PlanningProfile;
  }): string[] {
    const warnings: string[] = [];
    if (params.model != null) {
      warnings.push(
        `Requested model override "${params.model}" will only take effect when the configured ACP adapter honors it.`
      );
    }
    if (params.effort != null) {
      warnings.push(
        `Requested effort "${params.effort}" is recorded for orchestration, but ACP adapters may ignore it.`
      );
    }
    if (params.planningProfile != null) {
      warnings.push(
        `Planning profile "${params.planningProfile}" is enforced through the synthesized prompt, not a guaranteed ACP runtime mode.`
      );
    }
    if (Object.keys(this.deps.config.mcpServers).length > 0) {
      warnings.push(
        "Configured MCP servers are recorded by Puppenclaw, but ACP adapter-side MCP injection must be handled by the target agent command."
      );
    }
    if (this.resolveRawAgentCommand(params.agent) !== params.agent) {
      warnings.push(`Using configured raw ACP agent command for ${params.agent}.`);
    }
    return warnings;
  }

  private resolveRawAgentCommand(agent: AgentKind): string {
    return this.deps.config.agentCommands[agent] ?? DEFAULT_ACPX_AGENT_COMMANDS[agent];
  }

  private buildPlanningPromptPrefix(params: {
    agent: AgentKind;
    planningProfile?: PlanningProfile;
  }): string | undefined {
    const profile = params.planningProfile;
    if (profile == null) {
      return undefined;
    }
    const lines = [
      `You are running through Puppenclaw on the ${params.agent} backend.`,
      "Plan before implementation, keep ownership explicit, and only return to the human on a real decision boundary."
    ];
    if (profile === "deep") {
      lines.push(
        "Use a deep planning pass first: clarify scope, architecture, major file or system changes, validation strategy, and open decision boundaries before coding."
      );
    } else if (profile === "quick") {
      lines.push(
        "Use a short planning pass first: summarize the implementation approach, main changes, and validation steps before coding."
      );
    } else {
      lines.push(
        "Planning profile is off: keep planning concise, but do not skip clarification when key requirements are missing."
      );
    }
    return lines.join("\n");
  }

  private buildVerbArgs(
    agent: AgentKind,
    cwd: string,
    command: string[],
    prompt = false,
    permissionMode?: PermissionMode
  ): string[] {
    const args = ["--format", "json", "--json-strict", "--cwd", cwd];
    if (prompt) {
      args.push(...buildPermissionArgs(permissionMode ?? this.deps.config.permissionMode));
      args.push("--non-interactive-permissions", "deny");
    }
    const rawAgentCommand = this.deps.config.agentCommands[agent];
    if (rawAgentCommand != null && rawAgentCommand.trim().length > 0) {
      args.push("--agent", rawAgentCommand.trim());
    } else {
      args.push(agent);
    }
    args.push(...command);
    return args;
  }

  private async ensureRuntimeSession(params: {
    name: string;
    agent: AgentKind;
    directory: string;
  }): Promise<void> {
    const status = await this.getRuntimeStatus(params);
    if (status.exists && status.status !== "dead") {
      return;
    }
    const args = this.buildVerbArgs(params.agent, params.directory, [
      "sessions",
      "new",
      "--name",
      params.name
    ]);
    await this.runControlCommand({
      args,
      cwd: params.directory
    });
  }

  private async getRuntimeStatus(params: {
    name: string;
    agent: AgentKind;
    directory: string;
  }): Promise<RuntimeStatus> {
    const result = await this.runControlCommand({
      args: this.buildVerbArgs(params.agent, params.directory, [
        "status",
        "--session",
        params.name
      ]),
      cwd: params.directory,
      allowNoSession: true
    });
    const events = parseJsonLines(result.stdout);
    const error = events.map((event) => toErrorRecord(event)).find(Boolean) ?? null;
    if (error?.code === "NO_SESSION") {
      return { exists: false };
    }
    const detail = events.find((event) => toErrorRecord(event) == null) ?? null;
    if (isNoSessionStatus(detail)) {
      return { exists: false };
    }
    return {
      exists: detail != null,
      ...(detail != null ? { status: asOptionalString(detail.status) ?? "unknown", raw: detail } : {})
    };
  }

  private async runTurn(params: {
    session: SessionInfo;
    promptText: string;
    permissionMode: PermissionMode;
  }): Promise<TurnResult> {
    const args = this.buildVerbArgs(
      params.session.agent,
      params.session.directory,
      ["prompt", "--session", params.session.name, "--file", "-"],
      true,
      params.permissionMode
    );
    const spawnCommand = resolveSpawnCommand(this.deps.config.acpxCommand ?? "acpx", args);
    const child = spawnCommand.shell
      ? spawn(spawnCommand.command, {
          cwd: params.session.directory,
          stdio: ["pipe", "pipe", "pipe"],
          shell: true
        })
      : spawn(spawnCommand.command, spawnCommand.args, {
          cwd: params.session.directory,
          stdio: ["pipe", "pipe", "pipe"]
        });

    child.stdin.setDefaultEncoding("utf8");
    child.stdin.write(params.promptText);
    child.stdin.end();

    const events: PromptEvent[] = [];
    const dispatchTasks: Array<Promise<void>> = [];
    const outputChunks: string[] = [];
    let latestTokenUsage: TokenUsage | undefined;
    let pendingStdout = "";
    let stderr = "";
    const consumeLine = (line: string): void => {
      const event = parsePromptEventLine(line);
      if (event != null) {
        events.push(event);
        if (event.type === "text_delta" && event.stream === "output") {
          outputChunks.push(event.text);
          dispatchTasks.push(this.deps.outputRouter.onChunk(params.session.name, event.text));
        }
        if (event.type === "status" && (event.used != null || event.size != null)) {
          latestTokenUsage = {
            ...(event.used != null ? { used: event.used } : {}),
            ...(event.size != null ? { size: event.size } : {})
          };
        }
        return;
      }

      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isRecord(parsed)) {
          return;
        }
        const rawText =
          asOptionalString(parsed.text) ??
          (isRecord(parsed.content) ? asOptionalString(parsed.content.text) : undefined);
        if (rawText != null) {
          outputChunks.push(rawText);
          dispatchTasks.push(this.deps.outputRouter.onChunk(params.session.name, rawText));
        }
        const used = asOptionalFiniteNumber(parsed.used);
        const size = asOptionalFiniteNumber(parsed.size);
        if (used != null || size != null) {
          latestTokenUsage = {
            ...(used != null ? { used } : {}),
            ...(size != null ? { size } : {})
          };
        }
      } catch {
        // ignore malformed fallback lines
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pendingStdout += chunk;
      while (true) {
        const newlineIndex = pendingStdout.indexOf("\n");
        if (newlineIndex < 0) {
          break;
        }
        const line = pendingStdout.slice(0, newlineIndex).trim();
        pendingStdout = pendingStdout.slice(newlineIndex + 1);
        if (line) {
          consumeLine(line);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    }).catch((error) => {
      throw new PuppenclawError("ACP_TURN_FAILED", ensureError(error).message);
    });

    const trailingLine = pendingStdout.trim();
    if (trailingLine) {
      consumeLine(trailingLine);
    }

    await Promise.all(dispatchTasks);

    const output = outputChunks.join("").trim() || summarizePromptEvents(events).trim();
    const errorEvent = events.find((event): event is Extract<PromptEvent, { type: "error" }> => event.type === "error");
    if (errorEvent != null) {
      await this.deps.outputRouter.onError(
        params.session.name,
        new Error(errorEvent.message)
      );
      return {
        output: errorEvent.message,
        warnings: [],
        transcript: [
          {
            role: "status",
            text: errorEvent.message,
            createdAt: nowIso()
          }
        ],
        state: "failed"
      };
    }
    if ((exitCode ?? 0) !== 0) {
      const message = stderr.trim() || `acpx exited with code ${exitCode ?? "unknown"}`;
      await this.deps.outputRouter.onError(params.session.name, new Error(message));
      return {
        output: message,
        warnings: [],
        transcript: [
          {
            role: "status",
            text: message,
            createdAt: nowIso()
          }
        ],
        state: "failed"
      };
    }

    const tokenUsage = latestTokenUsage;
    const question = resolveQuestionFromOutput(output);
    if (question != null) {
      await this.deps.outputRouter.onQuestion(params.session.name, question);
    }
    await this.deps.outputRouter.onComplete(
      params.session.name,
      question != null ? "Turn completed and is waiting for user input." : "Turn completed."
    );

    return {
      output,
      ...(question != null ? { question } : {}),
      ...(tokenUsage != null ? { tokenUsage } : {}),
      warnings: [],
      transcript: makeAssistantTranscript(output),
      state: question != null ? "waiting_input" : "idle"
    };
  }

  private async runControlCommand(params: {
    args: string[];
    cwd: string;
    allowNoSession?: boolean;
  }): Promise<ControlCommandResult> {
    return await new Promise<ControlCommandResult>((resolve, reject) => {
      const spawnCommand = resolveSpawnCommand(
        this.deps.config.acpxCommand ?? "acpx",
        params.args
      );
      const child = spawnCommand.shell
        ? spawn(spawnCommand.command, {
            cwd: params.cwd,
            stdio: ["ignore", "pipe", "pipe"],
            shell: true
          })
        : spawn(spawnCommand.command, spawnCommand.args, {
            cwd: params.cwd,
            stdio: ["ignore", "pipe", "pipe"]
          });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error: Error) => {
        reject(
          new PuppenclawError(
            "ACP_CONTROL_FAILED",
            `Failed running acpx command: ${ensureError(error).message}`
          )
        );
      });
      child.once("close", (exitCode: number | null) => {
        const events = parseJsonLines(stdout);
        const errorEvent = events.map((event) => toErrorRecord(event)).find(Boolean) ?? null;
        if (errorEvent != null && !(params.allowNoSession && errorEvent.code === "NO_SESSION")) {
          reject(
            new PuppenclawError(
              errorEvent.code ?? "ACP_CONTROL_FAILED",
              errorEvent.message
            )
          );
          return;
        }
        if ((exitCode ?? 0) !== 0 && !(params.allowNoSession && errorEvent?.code === "NO_SESSION")) {
          reject(
            new PuppenclawError(
              "ACP_CONTROL_FAILED",
              stderr.trim() || `acpx exited with code ${exitCode ?? "unknown"}`
            )
          );
          return;
        }
        resolve({
          stdout,
          stderr,
          exitCode
        });
      });
    });
  }
}
