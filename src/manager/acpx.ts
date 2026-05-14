import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionStore } from "../shared/store.js";
import { DEFAULT_MAX_SESSIONS } from "../shared/schema.js";
import { ensureError, PuppenclawError } from "../shared/errors.js";
import type { PluginLogger } from "../shared/logger.js";
import type { OutputRouter } from "../shared/output-router.js";
import { jsonToolResult, textToolResult } from "../shared/tool-results.js";
import type {
  AgentKind,
  CostParams,
  EffortLevel,
  FocusParams,
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
  SuspendParams,
  ToolResult,
  TokenUsage,
  UnfocusParams
} from "../shared/types.js";
import { loadContextFiles, nowIso, summarizePromptEvents } from "../shared/utils.js";
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

type InstalledSkill = {
  name: string;
  sourcePath: string;
  targetPath: string;
};

type AvailableSkill = {
  name: string;
  sourcePath: string;
};

const CONNECTED_SESSION_STATES: ReadonlySet<SessionInfo["state"]> = new Set([
  "idle",
  "running",
  "waiting_input"
]);
const TERMINAL_SESSION_STATES: ReadonlySet<SessionInfo["state"]> = new Set([
  "completed",
  "failed",
  "stopped"
]);
const DEFAULT_FOCUS_LEASE_MS = 45_000;
const MAX_REHYDRATION_CHARS = 800_000;
const SKILL_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/u;
const PACKAGE_SKILLS_ROOT = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "skills"
);

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

function asOptionalTextDelta(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function describeRuntimeStatus(status: RuntimeStatus): string {
  if (!status.exists) {
    return "no active session";
  }
  const raw = status.raw ?? {};
  const summary = asOptionalString(raw.summary);
  return [status.status, summary].filter(Boolean).join(": ") || "unknown";
}

function isRuntimeStatusReady(status: RuntimeStatus): boolean {
  if (!status.exists || status.status === "dead") {
    return false;
  }
  const raw = status.raw ?? {};
  const summary = asOptionalString(raw.summary);
  const combined = `${status.status ?? ""} ${summary ?? ""}`;
  return !/(no active session|needs reconnect|reconnect|starting|initializing|pending|dead)/iu.test(
    combined
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
    const text = asOptionalTextDelta(content.text);
    if (text != null) {
      return {
        type: "text_delta",
        text,
        stream: input.stream,
        ...(input.tag != null ? { tag: input.tag } : {})
      };
    }
  }
  const text =
    asOptionalTextDelta(input.payload.text) ?? asOptionalTextDelta(input.payload.content);
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
  if (isRecord(parsed.error)) {
    return {
      type: "error",
      payload: parsed.error
    };
  }
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

function dedupeSkillNames(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function validateSkillNames(values: readonly string[]): string[] {
  const names = dedupeSkillNames(values);
  for (const name of names) {
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new PuppenclawError(
        "INVALID_SKILL_NAME",
        `Invalid skill name "${name}". Skill names may only contain letters, numbers, dot, underscore, and dash.`
      );
    }
  }
  return names;
}

async function isFile(path: string): Promise<boolean> {
  const file = await stat(path).catch(() => null);
  return file?.isFile() ?? false;
}

function mergeTranscript(
  previous: readonly SessionTranscriptEntry[],
  additions: readonly SessionTranscriptEntry[]
): SessionTranscriptEntry[] {
  return [...previous, ...additions].slice(-200);
}

function isConnectedSession(session: SessionInfo): boolean {
  return CONNECTED_SESSION_STATES.has(session.state);
}

function isTerminalSession(session: SessionInfo): boolean {
  return TERMINAL_SESSION_STATES.has(session.state);
}

function isFocusLeaseActive(session: SessionInfo, nowMs = Date.now()): boolean {
  if (session.focusedUntil == null) {
    return false;
  }
  const leaseUntil = Date.parse(session.focusedUntil);
  return Number.isFinite(leaseUntil) && leaseUntil > nowMs;
}

function withoutFocusLease(session: SessionInfo): SessionInfo {
  const { focusedUntil: _focusedUntil, ...rest } = session;
  return rest;
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
  if (process.platform === "win32") {
    if (/^[A-Za-z0-9_./:@%+=,\\-]+$/u.test(value)) {
      return value;
    }
    return `"${value.replaceAll('"', '\\"')}"`;
  }
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
  private readonly activeTurns = new Set<string>();
  private readonly stopRequests = new Set<string>();

  constructor(
    private readonly deps: {
      config: ParsedPluginConfig;
      logger: PluginLogger;
      store: SessionStore;
      outputRouter: OutputRouter;
    }
  ) {}

  async start(params: StartParams): Promise<ToolResult> {
    return await this.withSessionTurnLock(params.name, async () => {
    const directory = resolvePath(params.directory);
    const now = nowIso();
    const requestedSkills = validateSkillNames(params.skills ?? []);
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
    }
    if (existing == null || !isConnectedSession(existing)) {
      await this.ensureConnectedCapacity(params.name);
    }

    const installedSkills = await this.installSessionSkills(directory, requestedSkills);
    const installedSkillNames = installedSkills.map((skill) => skill.name);
    const session = existing ?? this.createSession({
      name: params.name,
      agent: params.agent,
      directory,
      permissionMode: params.permissionMode ?? this.deps.config.permissionMode,
      ...(params.effort != null ? { effort: params.effort } : {}),
      ...(params.planningProfile != null ? { planningProfile: params.planningProfile } : {}),
      ...(params.model != null ? { model: params.model } : {}),
      ...(installedSkillNames.length > 0 ? { skills: installedSkillNames } : {}),
      createdAt: now
    });
    const sessionSkills = dedupeSkillNames([
      ...(session.skills ?? []),
      ...installedSkillNames
    ]);

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
      directory,
      ...(params.model ?? session.model ? { model: params.model ?? session.model } : {})
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
    const runtimePromptText =
      session.state === "suspended"
        ? this.buildRehydrationPrompt(session, promptText)
        : promptText;
    const turn = await this.runTurn({
      session,
      promptText: runtimePromptText,
      permissionMode: session.permissionMode
    });
    const stoppedDuringTurn = this.stopRequests.delete(params.name);

    const nextSession: SessionInfo = {
      ...session,
      state: stoppedDuringTurn ? "stopped" : turn.state,
      lastActivity: nowIso(),
      warnings: dedupeWarnings([...warnings, ...turn.warnings]),
      ...(sessionSkills.length > 0 ? { skills: sessionSkills } : {}),
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
      },
      ...(stoppedDuringTurn ? { lastStopReason: "stopped by user" } : {})
    };

    await this.deps.store.upsertSession(nextSession);
    return textToolResult(`Started session ${params.name}.`, {
      session: nextSession,
      output: turn.output,
      contextFiles: context.files,
      skills: installedSkills
    });
    });
  }

  async send(params: SendParams): Promise<ToolResult> {
    return await this.withSessionTurnLock(params.name, async () => {
    const session = this.requireSession(params.name);
    if (!isConnectedSession(session)) {
      await this.ensureConnectedCapacity(params.name);
    }
    await this.ensureRuntimeSession({
      name: session.name,
      agent: session.agent,
      directory: session.directory,
      ...(session.model != null ? { model: session.model } : {})
    });
    const context = await loadContextFiles(session.directory, params.contextFiles);
    const prefix = params.ultrathink ? "Use a high-effort reasoning pass for this reply.\n\n" : "";
    const promptText = [prefix + params.message.trim(), context.promptText].filter(Boolean).join("\n\n");
    const runtimePromptText =
      session.state === "suspended"
        ? this.buildRehydrationPrompt(session, promptText)
        : promptText;
    const turn = await this.runTurn({
      session,
      promptText: runtimePromptText,
      permissionMode: session.permissionMode
    });
    const stoppedDuringTurn = this.stopRequests.delete(params.name);

    const nextSession: SessionInfo = {
      ...session,
      state: stoppedDuringTurn ? "stopped" : turn.state,
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
          : {}),
      ...(stoppedDuringTurn ? { lastStopReason: "stopped by user" } : {})
    };

    await this.deps.store.upsertSession(nextSession);
    return textToolResult(`Updated session ${params.name}.`, {
      session: nextSession,
      output: turn.output,
      contextFiles: context.files
    });
    });
  }

  async stop(params: StopParams): Promise<ToolResult> {
    const session = this.requireSession(params.name);
    this.stopRequests.add(params.name);
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
      ...withoutFocusLease(session),
      state: "stopped",
      lastActivity: nowIso(),
      lastStopReason: "stopped by user"
    };
    await this.deps.store.upsertSession(nextSession);
    if (!this.activeTurns.has(params.name)) {
      this.stopRequests.delete(params.name);
    }
    return textToolResult(`Stopped session ${params.name}.`, {
      session: nextSession
    });
  }

  async resume(params: ResumeParams): Promise<ToolResult> {
    const session = this.requireSession(params.name);
    if (!isConnectedSession(session)) {
      await this.ensureConnectedCapacity(session.name);
    }
    await this.ensureRuntimeSession({
      name: session.name,
      agent: session.agent,
      directory: session.directory,
      ...(session.model != null ? { model: session.model } : {})
    });
    const nextSession: SessionInfo = {
      ...session,
      state: "idle"
    };
    await this.deps.store.upsertSession(nextSession);
    return textToolResult(`Resumed session ${params.name}.`, {
      session: nextSession
    });
  }

  async suspend(params: SuspendParams): Promise<ToolResult> {
    const session = this.requireSession(params.name);
    if (this.isTurnActive(session)) {
      throw new PuppenclawError(
        "TURN_ALREADY_RUNNING",
        `Session ${params.name} is currently running a turn and cannot be suspended.`
      );
    }
    if (session.state === "suspended" || isTerminalSession(session)) {
      return textToolResult(`Session ${params.name} is not connected.`, {
        session
      });
    }
    const nextSession = await this.suspendTrackedSession(session, "suspended by user");
    return textToolResult(`Suspended session ${params.name}.`, {
      session: nextSession
    });
  }

  async focus(params: FocusParams): Promise<ToolResult> {
    const session = this.requireSession(params.name);
    const ttlMs = params.ttlMs ?? DEFAULT_FOCUS_LEASE_MS;
    const nextSession: SessionInfo = {
      ...session,
      focusedUntil: new Date(Date.now() + ttlMs).toISOString()
    };
    await this.deps.store.upsertSession(nextSession);
    return textToolResult(`Focused session ${params.name}.`, {
      session: nextSession
    });
  }

  async unfocus(params: UnfocusParams): Promise<ToolResult> {
    const session = this.requireSession(params.name);
    const nextSession = withoutFocusLease(session);
    await this.deps.store.upsertSession(nextSession);
    return textToolResult(`Unfocused session ${params.name}.`, {
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
      contextFiles: [],
      skills: source.skills ?? []
    });
    return textToolResult(`Forked ${params.source} into ${params.target}.`, result.details);
  }

  async listSkills(): Promise<ToolResult> {
    return jsonToolResult(
      {
        skills: await this.listAvailableSkills()
      },
      "Available Puppenclaw skills"
    );
  }

  async status(params: StatusParams = {}): Promise<ToolResult> {
    if (params.name == null) {
      return jsonToolResult(
        {
          sessions: this.deps.store
            .listSessions()
            .map((session) => this.decorateVisibleSession(session))
        },
        "Tracked Puppenclaw sessions"
      );
    }
    const session = this.decorateVisibleSession(this.requireSession(params.name));
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

  private async withSessionTurnLock<T>(name: string, run: () => Promise<T>): Promise<T> {
    if (this.activeTurns.has(name)) {
      throw new PuppenclawError(
        "TURN_ALREADY_RUNNING",
        `Session ${name} is already running a turn.`
      );
    }
    this.activeTurns.add(name);
    this.stopRequests.delete(name);
    try {
      return await run();
    } finally {
      this.activeTurns.delete(name);
    }
  }

  private isTurnActive(session: SessionInfo): boolean {
    return this.activeTurns.has(session.name) || session.state === "running";
  }

  private decorateVisibleSession(session: SessionInfo): SessionInfo {
    if (!this.activeTurns.has(session.name)) {
      return session;
    }
    return {
      ...session,
      state: "running"
    };
  }

  private async ensureConnectedCapacity(incomingSessionName: string): Promise<void> {
    const incoming = this.deps.store.getSession(incomingSessionName);
    if (incoming != null && isConnectedSession(incoming)) {
      return;
    }

    const maxSessions = this.deps.config.maxSessions || DEFAULT_MAX_SESSIONS;
    const connectedSessions = this.deps.store.listSessions().filter(isConnectedSession);
    if (connectedSessions.length < maxSessions) {
      return;
    }

    const evictionCandidate = connectedSessions
      .filter((session) => session.name !== incomingSessionName)
      .filter((session) => !this.isTurnActive(session))
      .filter((session) => !isFocusLeaseActive(session))
      .sort((left, right) => Date.parse(left.lastActivity) - Date.parse(right.lastActivity))
      .at(0);

    if (evictionCandidate == null) {
      throw new PuppenclawError(
        "MAX_SESSIONS_REACHED",
        `Puppenclaw is already tracking ${connectedSessions.length} connected sessions and none can be suspended.`
      );
    }

    await this.suspendTrackedSession(
      evictionCandidate,
      `suspended by LRU eviction for ${incomingSessionName}`
    );
  }

  private async suspendTrackedSession(
    session: SessionInfo,
    reason: string
  ): Promise<SessionInfo> {
    await this.runControlCommand({
      args: this.buildVerbArgs(session.agent, session.directory, [
        "sessions",
        "close",
        session.name
      ]),
      cwd: session.directory
    }).catch((error) => {
      this.deps.logger.warn(
        `Unable to close ACPX session ${session.name}: ${ensureError(error).message}`
      );
    });

    const nextSession: SessionInfo = {
      ...withoutFocusLease(session),
      state: "suspended",
      lastStopReason: reason
    };
    await this.deps.store.upsertSession(nextSession);
    this.deps.outputRouter.clear(session.name);
    return nextSession;
  }

  private buildRehydrationPrompt(session: SessionInfo, newPrompt: string): string {
    const transcriptText = session.transcript
      .map((entry) => `${entry.role.toUpperCase()}: ${entry.text}`)
      .join("\n\n")
      .trim();
    if (!transcriptText) {
      return newPrompt;
    }
    if (transcriptText.length > MAX_REHYDRATION_CHARS) {
      throw new PuppenclawError(
        "SESSION_HISTORY_TOO_LARGE",
        `Session ${session.name} has too much stored transcript to rehydrate safely.`
      );
    }
    return [
      `This Puppenclaw session ${session.name} was disconnected from the ACP runtime to free a worker slot.`,
      "Rehydrate the following transcript as prior context. Do not repeat it to the user unless needed.",
      transcriptText,
      "Continue with this new user message:",
      newPrompt
    ].join("\n\n");
  }

  private skillSearchRoots(): string[] {
    return dedupeStrings([
      ...this.deps.config.skillRoots.map((root) => resolvePath(root)),
      PACKAGE_SKILLS_ROOT
    ]);
  }

  private async listAvailableSkills(): Promise<AvailableSkill[]> {
    const byName = new Map<string, AvailableSkill>();
    for (const root of this.skillSearchRoots()) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || !SKILL_NAME_PATTERN.test(entry.name)) {
          continue;
        }
        const sourcePath = join(root, entry.name, "SKILL.md");
        if (!byName.has(entry.name) && (await isFile(sourcePath))) {
          byName.set(entry.name, {
            name: entry.name,
            sourcePath
          });
        }
      }
    }
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  private async resolveSkillPath(name: string): Promise<string | undefined> {
    for (const root of this.skillSearchRoots()) {
      const sourcePath = join(root, name, "SKILL.md");
      if (await isFile(sourcePath)) {
        return sourcePath;
      }
    }
    return undefined;
  }

  private async installSessionSkills(
    directory: string,
    skills: readonly string[]
  ): Promise<InstalledSkill[]> {
    const names = validateSkillNames(skills);
    if (names.length === 0) {
      return [];
    }

    const installed: InstalledSkill[] = [];
    for (const name of names) {
      const sourcePath = await this.resolveSkillPath(name);
      if (sourcePath == null) {
        throw new PuppenclawError(
          "SKILL_NOT_FOUND",
          `Skill "${name}" was not found in configured Puppenclaw skill roots.`
        );
      }

      const targetDir = join(directory, ".claude", "skills", name);
      const targetPath = join(targetDir, "SKILL.md");
      await mkdir(targetDir, { recursive: true });
      await copyFile(sourcePath, targetPath);
      installed.push({
        name,
        sourcePath,
        targetPath
      });
    }
    return installed;
  }

  private createSession(params: {
    name: string;
    agent: AgentKind;
    directory: string;
    permissionMode: PermissionMode;
    effort?: EffortLevel;
    planningProfile?: PlanningProfile;
    model?: string;
    skills?: string[];
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
      ...(params.skills != null && params.skills.length > 0 ? { skills: params.skills } : {}),
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
    if (this.deps.config.agentCommands[params.agent]?.trim()) {
      warnings.push(`Using configured raw ACP agent command for ${params.agent}.`);
    }
    return warnings;
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
    const args = ["--format", "json"];
    if (!prompt) {
      args.push("--json-strict");
    }
    args.push("--cwd", cwd);
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
    model?: string;
  }): Promise<void> {
    const status = await this.getRuntimeStatus(params);
    if (!status.exists || status.status === "dead") {
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
    if (params.model != null) {
      await this.runControlCommand({
        args: this.buildVerbArgs(params.agent, params.directory, [
          "set",
          "--session",
          params.name,
          "model",
          params.model
        ]),
        cwd: params.directory
      }).catch((error) => {
        this.deps.logger.warn(
          `Unable to set ACPX model for session ${params.name}: ${ensureError(error).message}`
        );
      });
    }
    await this.waitForRuntimeSessionReady(params);
  }

  private async waitForRuntimeSessionReady(params: {
    name: string;
    agent: AgentKind;
    directory: string;
  }): Promise<void> {
    const deadline = Date.now() + 20_000;
    let lastStatus = "unknown";
    while (Date.now() < deadline) {
      try {
        const status = await this.getRuntimeStatus(params);
        lastStatus = describeRuntimeStatus(status);
        if (isRuntimeStatusReady(status)) {
          return;
        }
      } catch (error) {
        lastStatus = ensureError(error).message;
      }
      await sleep(500);
    }
    this.deps.logger.warn(
      `Timed out waiting for ACPX session ${params.name} to become ready: ${lastStatus}`
    );
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
    retryAfterReconnect?: boolean;
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
          asOptionalTextDelta(parsed.text) ??
          (isRecord(parsed.content) ? asOptionalTextDelta(parsed.content.text) : undefined);
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
    const reconnectEvent = events.find(
      (event): event is Extract<PromptEvent, { type: "status" }> =>
        event.type === "status" && /needs reconnect/iu.test(event.text)
    );
    if (reconnectEvent != null && outputChunks.length === 0) {
      if (params.retryAfterReconnect !== true) {
        await this.waitForRuntimeSessionReady({
          name: params.session.name,
          agent: params.session.agent,
          directory: params.session.directory
        });
        return await this.runTurn({
          ...params,
          retryAfterReconnect: true
        });
      }
      await this.deps.outputRouter.onError(
        params.session.name,
        new Error(reconnectEvent.text)
      );
      return {
        output: reconnectEvent.text,
        warnings: [],
        transcript: [
          {
            role: "status",
            text: reconnectEvent.text,
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
