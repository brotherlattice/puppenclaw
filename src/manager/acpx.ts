import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { dirname, extname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionStore } from "../shared/store.js";
import { UsageLedgerStore } from "../shared/usage-ledger.js";
import { hasNonzeroUsage, normalizeCodexUsage, normalizeUsage } from "../shared/usage.js";
import { DEFAULT_MAX_SESSIONS } from "../shared/schema.js";
import { ensureError, PuppenclawError } from "../shared/errors.js";
import type { PluginLogger } from "../shared/logger.js";
import type { OutputRouter } from "../shared/output-router.js";
import { killProcessTree, killProcessTreeWithEscalation } from "../shared/process-tree.js";
import {
  acceptedReasoningModes,
  reasoningProfileFor,
  resolveReasoningMode
} from "../shared/reasoning.js";
import { jsonToolResult, textToolResult } from "../shared/tool-results.js";
import type {
  AgentKind,
  CostParams,
  EffortLevel,
  FocusParams,
  ForkParams,
  InteractionMode,
  ModelProviderConfig,
  NativePlanEntry,
  NormalizedUsage,
  ParsedPluginConfig,
  PermissionMode,
  PlanningProfile,
  PromptEvent,
  QuiesceParams,
  QuiescenceReleaseParams,
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
  TurnOutputRole,
  TurnSignals,
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

type NativeModePreparation = {
  activeMode?: string;
  restoreMode?: string;
  warning?: string;
};

type TurnResult = {
  output: string;
  question?: string;
  tokenUsage?: TokenUsage;
  usage?: NormalizedUsage;
  stopReason?: string;
  durationMs?: number;
  warnings: string[];
  transcript: SessionTranscriptEntry[];
  state: SessionInfo["state"];
  signals?: TurnSignals;
};

function outputRoleForTurn(turn: TurnResult): TurnOutputRole {
  return turn.state === "failed" ? "status" : "assistant";
}

type ActiveTurnOutput = {
  sessionName: string;
  text: string;
  startedAt: string;
  updatedAt: string;
  complete: boolean;
};

type ActiveTurnProcess = {
  child: ChildProcess;
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
const SKILL_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/u;
const PACKAGE_SKILLS_ROOT = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "skills"
);
const RECONNECT_HISTORY_TIMEOUT_MS = 120_000;
const RECONNECT_HISTORY_POLL_MS = 750;
const MAX_ACTIVE_TURN_OUTPUT_CHARS = 120_000;
const MAX_CODEX_EVENT_TEXT_CHARS = 6_000;
const QUIESCENCE_CONTROL_TIMEOUT_MS = 1_000;
const QUIESCENCE_DRAIN_TIMEOUT_MS = 4_000;
const QUIESCENCE_POLL_MS = 25;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isReasoningOptionRejection(error: unknown): boolean {
  const message = ensureError(error).message;
  return /(?:unknown config option.*(?:effort|reasoning_effort)|invalid value for config option (?:effort|reasoning_effort)|(?:effort|reasoning).*not (?:available|supported)|unsupported.*(?:effort|reasoning))/iu.test(
    message
  );
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

type RuntimeModeState = {
  currentMode: string;
  availableModes?: string[];
};

function modeIdFromValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return asOptionalString(value);
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return asOptionalString(value.id) ?? asOptionalString(value.modeId);
}

function extractRuntimeModeState(value: unknown, depth = 0): RuntimeModeState | null {
  if (depth > 5 || !isRecord(value)) {
    return null;
  }
  const currentMode =
    modeIdFromValue(value.currentModeId) ??
    modeIdFromValue(value.currentMode) ??
    modeIdFromValue(value.mode) ??
    modeIdFromValue(value.current_mode_id) ??
    modeIdFromValue(value.desired_mode_id);
  const availableValues =
    (Array.isArray(value.availableModes) ? value.availableModes : undefined) ??
    (Array.isArray(value.modes) ? value.modes : undefined);
  if (currentMode != null && availableValues != null) {
    const availableModes = dedupeStrings(
      availableValues.map(modeIdFromValue).filter((mode): mode is string => mode != null)
    );
    if (availableModes.length > 0) {
      return { currentMode, availableModes };
    }
  }
  const configOptions =
    (Array.isArray(value.configOptions) ? value.configOptions : undefined) ??
    (Array.isArray(value.config_options) ? value.config_options : undefined);
  if (configOptions != null) {
    const modeOption = configOptions.find(
      (option) => isRecord(option) && asTrimmedString(option.id) === "mode"
    );
    if (isRecord(modeOption)) {
      const optionValues = Array.isArray(modeOption.options)
        ? modeOption.options.map((option) => {
            if (typeof option === "string") {
              return asOptionalString(option);
            }
            return isRecord(option)
              ? (asOptionalString(option.value) ?? asOptionalString(option.id))
              : undefined;
          })
        : [];
      const availableModes = dedupeStrings(
        optionValues.filter((mode): mode is string => mode != null)
      );
      const configuredCurrent =
        currentMode ??
        asOptionalString(modeOption.currentValue) ??
        asOptionalString(modeOption.current_value);
      if (configuredCurrent != null && availableModes.length > 0) {
        return { currentMode: configuredCurrent, availableModes };
      }
    }
  }
  for (const key of [
    "modeState",
    "sessionModeState",
    "acpx",
    "session",
    "runtime",
    "details",
    "capabilities",
    "options",
    "configOptions"
  ]) {
    const nested = extractRuntimeModeState(value[key], depth + 1);
    if (nested != null) {
      return nested;
    }
  }
  return currentMode != null ? { currentMode } : null;
}

function interactionPromptPrefix(mode: InteractionMode | undefined): string | undefined {
  if (mode === "plan") {
    return [
      "This is a read-only planning turn.",
      "Develop or revise the plan and surface genuine decision boundaries, but do not execute the plan or modify the workspace."
    ].join(" ");
  }
  if (mode === "execute") {
    return "This is the single approved execution turn. Carry out the approved work within the granted permissions and report the actual outcome.";
  }
  return undefined;
}

function mergeTurnSignals(...signals: Array<TurnSignals | undefined>): TurnSignals | undefined {
  const merged: TurnSignals = {};
  for (const signal of signals) {
    if (signal?.nativeMode != null) {
      merged.nativeMode = signal.nativeMode;
    }
    if (signal?.plan != null) {
      merged.plan = signal.plan;
    }
    if (signal?.inputRequest != null) {
      merged.inputRequest = signal.inputRequest;
    }
    if (signal?.stopReason != null) {
      merged.stopReason = signal.stopReason;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function signalsFromPromptEvents(events: readonly PromptEvent[]): TurnSignals | undefined {
  let signals: TurnSignals | undefined;
  for (const event of events) {
    switch (event.type) {
      case "mode":
        signals = mergeTurnSignals(signals, { nativeMode: event.mode });
        break;
      case "plan":
        signals = mergeTurnSignals(signals, {
          plan: { source: "acp", entries: event.entries }
        });
        break;
      case "tool_call":
        if (event.nativeToolName === "ExitPlanMode") {
          signals = mergeTurnSignals(signals, {
            plan: {
              source: "claude-tool",
              ...(signals?.plan?.entries != null ? { entries: signals.plan.entries } : {})
            }
          });
        } else if (event.nativeToolName === "AskUserQuestion") {
          signals = mergeTurnSignals(signals, {
            inputRequest: {
              source: "claude-tool",
              toolName: "AskUserQuestion",
              ...(event.inputRequestText != null ? { text: event.inputRequestText } : {})
            }
          });
        }
        break;
      case "done":
        if (event.stopReason != null) {
          signals = mergeTurnSignals(signals, { stopReason: event.stopReason });
        }
        break;
      default:
        break;
    }
  }
  return signals;
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

function buildCodexPermissionArgs(mode: PermissionMode): string[] {
  return mode === "approve-all"
    ? ["--dangerously-bypass-approvals-and-sandbox"]
    : ["--sandbox", "read-only"];
}

function buildCodexPermissionPrompt(promptText: string, mode: PermissionMode): string {
  if (mode !== "deny-all") {
    return promptText;
  }
  return [
    "Permission mode for this turn is deny-all.",
    "Do not call tools, execute commands, access external resources, or modify files. Answer only from the prompt and prior transcript.",
    "",
    promptText
  ].join("\n");
}

type CodexTurnPolicy =
  | "default"
  | "plan-no-tools"
  | "execute-tools"
  | "deny-all-no-tools";

function deriveCodexTurnPolicy(
  interactionMode: InteractionMode | undefined,
  permissionMode: PermissionMode
): CodexTurnPolicy {
  if (permissionMode === "deny-all") {
    return "deny-all-no-tools";
  }
  if (interactionMode === "plan") {
    return "plan-no-tools";
  }
  if (interactionMode === "execute") {
    return "execute-tools";
  }
  return "default";
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

function readMessages(value: JsonRecord | null | undefined): unknown[] {
  return Array.isArray(value?.messages) ? value.messages : [];
}

function extractTextContent(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractTextContent(entry));
  }
  if (!isRecord(value)) {
    return [];
  }
  const directText =
    asOptionalString(value.Text) ?? asOptionalString(value.text) ?? asOptionalString(value.content);
  return directText != null ? [directText] : [];
}

function extractVisibleContentText(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractVisibleContentText(entry));
  }
  if (!isRecord(value)) {
    return [];
  }
  const type = asTrimmedString(value.type).toLowerCase();
  if (/(reasoning|thinking|thought)/iu.test(type)) {
    return [];
  }
  const text =
    typeof value.text === "string"
      ? value.text
      : typeof value.output_text === "string"
        ? value.output_text
        : typeof value.content === "string"
          ? value.content
          : undefined;
  return text != null ? [text] : [];
}

function extractCodexLiveOutput(event: JsonRecord): string | undefined {
  const type = asTrimmedString(event.type).toLowerCase();
  if (/(reasoning|thinking|thought)/iu.test(type)) {
    return undefined;
  }

  const item =
    (isRecord(event.item) ? event.item : undefined) ??
    (isRecord(event.output_item) ? event.output_item : undefined) ??
    (isRecord(event.content) ? event.content : undefined);
  const subject = item ?? event;
  const subjectType = asTrimmedString(subject.type).toLowerCase();
  if (/(reasoning|thinking|thought)/iu.test(subjectType)) {
    return undefined;
  }

  // Tool protocol records are exposed only through structured activity
  // events. Check them before generic message/delta extraction because some
  // compatible providers wrap tool calls in message-shaped envelopes.
  const toolName = extractToolCallName(event, subject);
  if (
    toolName != null ||
    isToolCallEvent(type, subjectType) ||
    isToolOutputEvent(type, subjectType)
  ) {
    return undefined;
  }

  const assistantText = extractVisibleContentText(subject.content).join("");
  if (assistantText.length > 0 && isAssistantLikeEvent(type, subject)) {
    return assistantText;
  }

  const deltaText =
    typeof event.delta === "string"
      ? event.delta
      : typeof event.text === "string" && /(?:message|output|text).*delta/iu.test(type)
        ? event.text
        : undefined;
  if (deltaText != null) {
    return deltaText;
  }

  if (type === "error" || subjectType === "error") {
    const message =
      asOptionalString(event.message) ??
      asOptionalString(subject.message) ??
      asOptionalString(event.error) ??
      "Codex reported an error.";
    if (isTransientCodexReconnectMessage(message)) {
      return undefined;
    }
    return `\n[error] ${message}\n`;
  }

  return undefined;
}

function extractCodexActivity(event: JsonRecord):
  | {
      type: "tool_call" | "tool_output";
      text?: string;
      title?: string;
    }
  | null {
  const type = asTrimmedString(event.type).toLowerCase();
  const item =
    (isRecord(event.item) ? event.item : undefined) ??
    (isRecord(event.output_item) ? event.output_item : undefined) ??
    (isRecord(event.content) ? event.content : undefined);
  const subject = item ?? event;
  const subjectType = asTrimmedString(subject.type).toLowerCase();
  const toolName = extractToolCallName(event, subject);
  if (toolName != null || isToolCallEvent(type, subjectType)) {
    const args = extractToolCallArguments(event, subject);
    return {
      type: "tool_call",
      title: toolName ?? "tool",
      ...(args != null
        ? { text: sanitizeActiveTurnText(truncateOneLine(args, 280)) }
        : {})
    };
  }
  if (isToolOutputEvent(type, subjectType)) {
    const output =
      asOptionalString(subject.output) ??
      asOptionalString(subject.result) ??
      asOptionalString(event.output) ??
      extractVisibleContentText(subject.content).join("");
    return {
      type: "tool_output",
      ...(output != null
        ? { text: sanitizeActiveTurnText(tailText(output, MAX_CODEX_EVENT_TEXT_CHARS)) }
        : {})
    };
  }
  return null;
}

function extractToolCallName(...roots: unknown[]): string | undefined {
  for (const root of roots) {
    const direct = extractToolCallNameFromRecord(root);
    if (direct != null) {
      return direct;
    }
  }
  return undefined;
}

function extractToolCallNameFromRecord(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || !isRecord(value)) {
    return undefined;
  }
  const direct =
    asOptionalString(value.name) ??
    asOptionalString(value.tool_name) ??
    asOptionalString(value.function_name);
  if (direct != null && isLikelyToolCallRecord(value)) {
    return direct;
  }
  const functionRecord = isRecord(value.function) ? value.function : undefined;
  const functionName = asOptionalString(functionRecord?.name);
  if (functionName != null) {
    return functionName;
  }
  for (const key of ["tool_call", "function_call", "raw_item", "item", "output_item"]) {
    const nested = extractToolCallNameFromRecord(value[key], depth + 1);
    if (nested != null) {
      return nested;
    }
  }
  for (const key of ["tool_calls", "function_calls", "content", "output"]) {
    const collection = value[key];
    if (!Array.isArray(collection)) {
      continue;
    }
    for (const entry of collection) {
      const nested = extractToolCallNameFromRecord(entry, depth + 1);
      if (nested != null) {
        return nested;
      }
    }
  }
  return undefined;
}

function extractToolCallArguments(...roots: unknown[]): string | undefined {
  for (const root of roots) {
    const args = extractToolCallArgumentsFromRecord(root);
    if (args != null) {
      return args;
    }
  }
  return undefined;
}

function extractToolCallArgumentsFromRecord(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || !isRecord(value)) {
    return undefined;
  }
  const direct =
    asOptionalString(value.arguments) ??
    asOptionalString(value.args) ??
    asOptionalString(value.input);
  if (direct != null && isLikelyToolCallRecord(value)) {
    return direct;
  }
  const functionRecord = isRecord(value.function) ? value.function : undefined;
  const functionArgs =
    asOptionalString(functionRecord?.arguments) ?? asOptionalString(functionRecord?.args);
  if (functionArgs != null) {
    return functionArgs;
  }
  for (const key of ["tool_call", "function_call", "raw_item", "item", "output_item"]) {
    const nested = extractToolCallArgumentsFromRecord(value[key], depth + 1);
    if (nested != null) {
      return nested;
    }
  }
  for (const key of ["tool_calls", "function_calls", "content", "output"]) {
    const collection = value[key];
    if (!Array.isArray(collection)) {
      continue;
    }
    for (const entry of collection) {
      const nested = extractToolCallArgumentsFromRecord(entry, depth + 1);
      if (nested != null) {
        return nested;
      }
    }
  }
  return undefined;
}

function isLikelyToolCallRecord(value: JsonRecord): boolean {
  const type = asTrimmedString(value.type).toLowerCase();
  return (
    /(?:tool|function)_?call/iu.test(type) ||
    isRecord(value.function) ||
    value.tool_name != null ||
    value.function_name != null ||
    value.arguments != null ||
    value.args != null
  );
}

function isTransientCodexReconnectMessage(message: string): boolean {
  return (
    /reconnecting\.\.\.\s+\d+\/\d+/iu.test(message) &&
    /stream disconnected before completion|operation was aborted due to timeout|timeout/iu.test(
      message
    )
  );
}

function isAssistantLikeEvent(type: string, subject: JsonRecord): boolean {
  const role = asTrimmedString(subject.role).toLowerCase();
  const subjectType = asTrimmedString(subject.type).toLowerCase();
  return (
    role === "assistant" ||
    /assistant|message|output_text/iu.test(type) ||
    /assistant|message|output_text/iu.test(subjectType)
  );
}

function isToolCallEvent(type: string, subjectType: string): boolean {
  return (
    (/(?:tool|function)_?call/iu.test(type) || /(?:tool|function)_?call/iu.test(subjectType)) &&
    !isToolOutputEvent(type, subjectType)
  );
}

function isToolOutputEvent(type: string, subjectType: string): boolean {
  return /(?:tool|function)_?(?:call_)?output|command_output|exec_output/iu.test(
    `${type} ${subjectType}`
  );
}

function sanitizeActiveTurnText(text: string): string {
  return text
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/giu,
      "[redacted private key]"
    )
    .replace(
      /(["']?authorization["']?\s*:\s*["']?\s*bearer\s+)[^\s"',}]+/giu,
      "$1[redacted]"
    )
    .replace(
      /(["']?\b(?:api[_-]?key|token|secret|password)\b["']?\s*[:=]\s*["']?)[^"',}\s]+/giu,
      "$1[redacted]"
    );
}

function truncateOneLine(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/gu, " ").trim();
  if (oneLine.length <= maxChars) {
    return oneLine;
  }
  return `${oneLine.slice(0, maxChars)}...`;
}

function tailText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `[truncated ${text.length - maxChars} chars]\n${text.slice(-maxChars)}`;
}

function extractLatestAgentText(
  sessionRecord: JsonRecord | null | undefined,
  afterMessageCount: number | undefined
): string | undefined {
  const messages = readMessages(sessionRecord);
  const candidates =
    afterMessageCount != null && afterMessageCount >= 0
      ? messages.slice(afterMessageCount)
      : messages.slice(-8);
  for (const entry of candidates.toReversed()) {
    if (!isRecord(entry) || !isRecord(entry.Agent)) {
      continue;
    }
    const text = extractTextContent(entry.Agent.content).join("\n\n").trim();
    if (text.length > 0) {
      return text;
    }
  }
  return undefined;
}

function extractLatestAssistantHistoryText(
  historyRecord: JsonRecord | null | undefined,
  sinceMs: number
): string | undefined {
  const entries = Array.isArray(historyRecord?.entries) ? historyRecord.entries : [];
  for (const entry of [...entries].reverse()) {
    if (!isRecord(entry) || asTrimmedString(entry.role).toLowerCase() !== "assistant") {
      continue;
    }
    const timestampMs = Date.parse(asTrimmedString(entry.timestamp));
    if (Number.isFinite(timestampMs) && timestampMs < sinceMs - 5_000) {
      continue;
    }
    const text = asOptionalString(entry.text) ?? asOptionalString(entry.textPreview);
    if (text != null) {
      return text;
    }
  }
  return undefined;
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

function extractClaudeNativeToolName(
  payload: JsonRecord
): "ExitPlanMode" | "AskUserQuestion" | undefined {
  const metadata = isRecord(payload._meta) ? payload._meta : undefined;
  const claudeCode = isRecord(metadata?.claudeCode) ? metadata.claudeCode : undefined;
  const toolName = asOptionalString(claudeCode?.toolName);
  return toolName === "ExitPlanMode" || toolName === "AskUserQuestion" ? toolName : undefined;
}

function extractQuestionText(value: unknown, depth = 0): string | undefined {
  if (depth > 5) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const question = extractQuestionText(entry, depth + 1);
      if (question != null) {
        return question;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const question = asOptionalString(value.question);
  if (question != null) {
    return question.slice(0, 2_000);
  }
  for (const key of ["questions", "input", "rawInput"]) {
    const nested = extractQuestionText(value[key], depth + 1);
    if (nested != null) {
      return nested;
    }
  }
  return undefined;
}

function parsePlanEntries(payload: JsonRecord): NativePlanEntry[] {
  if (!Array.isArray(payload.entries)) {
    return [];
  }
  return payload.entries.flatMap((entry): NativePlanEntry[] => {
    if (!isRecord(entry)) {
      return [];
    }
    const content = asOptionalString(entry.content);
    if (content == null) {
      return [];
    }
    const status = asOptionalString(entry.status);
    const priority = asOptionalString(entry.priority);
    return [
      {
        content,
        ...(status != null ? { status } : {}),
        ...(priority != null ? { priority } : {})
      }
    ];
  });
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
    // The JSON-RPC response to session/prompt carries the billable per-turn
    // usage on result.usage (the Claude ACP adapter reports input/output/cache
    // there). The session/update "usage_update" only carries the context-window
    // used/size — so without this the persistent path records no real tokens.
    // Surface it as a usage-bearing status event → recordNormalizedUsage.
    if (isRecord(parsed.result)) {
      const stopReason = asOptionalString(parsed.result.stopReason);
      if (stopReason != null) {
        const usage = normalizeUsage(parsed.result.usage);
        return {
          type: "done",
          stopReason,
          ...(hasNonzeroUsage(usage) ? { usage } : {})
        };
      }
      if (isRecord(parsed.result.usage)) {
        const usage = normalizeUsage(parsed.result.usage);
        if (hasNonzeroUsage(usage)) {
          return { type: "status", text: "usage recorded", usage };
        }
      }
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
        const nativeToolName = extractClaudeNativeToolName(structured.payload);
        const inputRequestText =
          nativeToolName === "AskUserQuestion"
            ? extractQuestionText(structured.payload.rawInput)
            : undefined;
        return {
          type: "tool_call",
          text: status != null ? `${title} (${status})` : title,
          title,
          ...(status != null ? { status } : {}),
          ...(structured.tag != null ? { tag: structured.tag } : {}),
          ...(toolCallId != null ? { toolCallId } : {}),
          ...(nativeToolName != null ? { nativeToolName } : {}),
          ...(inputRequestText != null ? { inputRequestText } : {})
        };
      }
      case "plan":
        return {
          type: "plan",
          entries: parsePlanEntries(structured.payload)
        };
      case "current_mode_update": {
        const mode = asOptionalString(structured.payload.currentModeId);
        return mode == null ? null : { type: "mode", mode };
      }
      case "usage_update": {
        const used = asOptionalFiniteNumber(structured.payload.used);
        const size = asOptionalFiniteNumber(structured.payload.size);
        const usage = normalizeUsage(structured.payload);
        return {
          type: "status",
          text: used != null && size != null ? `usage updated: ${used}/${size}` : "usage updated",
          ...(structured.tag != null ? { tag: structured.tag } : {}),
          ...(used != null ? { used } : {}),
          ...(size != null ? { size } : {}),
          ...(hasNonzeroUsage(usage) ? { usage } : {})
        };
      }
      case "done": {
        const stopReason = asOptionalString(structured.payload.stopReason);
        return {
          type: "done",
          ...(stopReason != null ? { stopReason } : {})
        };
      }
      case "error": {
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
  return [...previous, ...additions];
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
      (part.startsWith('"') && part.endsWith('"')) ||
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
  const command = parts[0];
  if (command == null) {
    return {
      command: "acpx",
      args,
      shell: false
    };
  }
  const commandArgs = [...parts.slice(1), ...args];
  if (shouldUseShellForSpawnCommand(command)) {
    const suffix = commandArgs.map((value) => shellQuote(value)).join(" ");
    return {
      command: suffix.length > 0 ? `${shellQuote(command)} ${suffix}` : shellQuote(command),
      args: [],
      shell: true
    };
  }
  return {
    command,
    args: commandArgs,
    shell: false
  };
}

function shouldUseShellForSpawnCommand(command: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const extension = extname(command).toLowerCase();
  if (extension === ".exe" || extension === ".com") {
    return false;
  }
  if (extension === ".cmd" || extension === ".bat" || extension === ".ps1") {
    return true;
  }
  if (command.includes("\\") || command.includes("/")) {
    return false;
  }
  return true;
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

function formatTokenCount(value: number): string {
  return Math.trunc(value).toLocaleString("en-US");
}

function formatUsageLine(usage: NormalizedUsage): string {
  return `${formatTokenCount(usage.input)} in / ${formatTokenCount(usage.output)} out / ${formatTokenCount(
    usage.cacheRead
  )} cacheRead / ${formatTokenCount(usage.cacheWrite)} cacheWrite (${formatTokenCount(usage.total)} total)`;
}

function deriveUsageProvider(session: SessionInfo): string {
  switch (session.modelProvider?.kind) {
    case "claude-code":
      return "anthropic";
    case "codex-openai":
      return "openai";
    case "codex-openai-compatible":
      return session.modelProvider.id ?? "openai-compatible";
    default:
      return session.agent === "codex" ? "openai" : "anthropic";
  }
}

function deriveUsageModel(session: SessionInfo): string {
  return (
    session.model ??
    session.modelProvider?.model ??
    (session.agent === "codex" ? "codex-default" : "claude-default")
  );
}

export class AcpxSessionManager implements ISessionManager {
  private readonly activeTurns = new Set<string>();
  private readonly stopRequests = new Set<string>();
  private readonly activeTurnOutputs = new Map<string, ActiveTurnOutput>();
  private readonly activeTurnProcesses = new Map<string, ActiveTurnProcess>();
  private readonly lifecycleTails = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: {
      config: ParsedPluginConfig;
      logger: PluginLogger;
      store: SessionStore;
      outputRouter: OutputRouter;
      ledger?: UsageLedgerStore;
    }
  ) {}

  private recordTurnUsage(session: SessionInfo, turn: TurnResult): void {
    if (this.deps.ledger == null || turn.state === "failed") {
      return;
    }
    const usage = turn.usage;
    if (usage == null || !hasNonzeroUsage(usage)) {
      return;
    }
    try {
      this.deps.ledger.append({
        id: `usage-${randomUUID()}`,
        sessionName: session.name,
        agent: session.agent,
        provider: deriveUsageProvider(session),
        model: deriveUsageModel(session),
        usage,
        ...(turn.stopReason != null ? { stopReason: turn.stopReason } : {}),
        durationMs: turn.durationMs ?? 0,
        timestamp: nowIso()
      });
    } catch (error) {
      this.deps.logger.warn(
        `Puppenclaw usage ledger append failed for ${session.name}: ${ensureError(error).message}`
      );
    }
  }

  async start(params: StartParams): Promise<ToolResult> {
    return await this.withSessionTurnLock(params.name, params.lifecycleEpoch, async () => {
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
      const baseSession =
        existing ??
        this.createSession({
          name: params.name,
          agent: params.agent,
          directory,
          permissionMode: params.permissionMode ?? this.deps.config.permissionMode,
          ...(params.effort != null ? { effort: params.effort } : {}),
          ...(params.planningProfile != null ? { planningProfile: params.planningProfile } : {}),
          ...(params.model != null ? { model: params.model } : {}),
          ...(params.modelProviderId != null ? { modelProviderId: params.modelProviderId } : {}),
          ...(params.modelProvider != null ? { modelProvider: params.modelProvider } : {}),
          ...(installedSkillNames.length > 0 ? { skills: installedSkillNames } : {}),
          createdAt: now
        });
      const requestedSession =
        existing != null && params.effort != null
          ? { ...baseSession, effort: params.effort }
          : baseSession;
      const reasoning = this.resolveSessionReasoning(requestedSession);
      const session = reasoning.session;
      const sessionSkills = dedupeSkillNames([...(session.skills ?? []), ...installedSkillNames]);

      const warnings = dedupeWarnings([
        ...session.warnings,
        ...(reasoning.warning != null ? [reasoning.warning] : []),
        ...this.resolveCapabilityWarnings({
          agent: params.agent,
          ...(params.model != null ? { model: params.model } : {}),
          ...(params.effort != null ? { effort: params.effort } : {}),
          ...(params.planningProfile != null ? { planningProfile: params.planningProfile } : {})
        })
      ]);

      const provisionalSession: SessionInfo = {
        ...session,
        state: "running",
        lastActivity: now,
        warnings,
        ...(sessionSkills.length > 0 ? { skills: sessionSkills } : {}),
        handle: {
          runtimeSessionName: params.name,
          cwd: directory,
          agent: params.agent,
          mode: "persistent"
        }
      };
      // Persist the identity before starting external runtime work. A cleanup
      // request racing an ambiguous start response can then fence this runtime.
      await this.deps.store.upsertSession(provisionalSession);

      try {
        if (!this.usesOneShotRuntime(session)) {
          await this.ensureRuntimeSession({
            name: params.name,
            agent: params.agent,
            directory,
            ...((params.model ?? session.model) ? { model: params.model ?? session.model } : {}),
            ...(session.runtimeEffort != null ? { effort: session.runtimeEffort } : {}),
            ...((params.modelProvider ?? session.modelProvider)
              ? { modelProvider: params.modelProvider ?? session.modelProvider }
              : {})
          });
        }

        const context = await loadContextFiles(directory, params.contextFiles);
        const promptText = [
          interactionPromptPrefix(params.interactionMode),
          this.buildPlanningPromptPrefix({
            agent: params.agent,
            ...((params.planningProfile ?? session.planningProfile)
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
        const effectivePromptText = this.usesOneShotRuntime(session)
          ? this.buildOneShotContinuationPrompt(session, runtimePromptText)
          : runtimePromptText;
        const effectivePermissionMode = this.effectivePermissionMode(session);
        const turn = await this.runTurn({
          session,
          promptText: effectivePromptText,
          permissionMode: effectivePermissionMode,
          ...(params.interactionMode != null ? { interactionMode: params.interactionMode } : {})
        });
        const stoppedDuringTurn = this.stopRequests.delete(params.name);

        const nextSession: SessionInfo = {
          ...session,
          permissionMode: effectivePermissionMode,
          state: stoppedDuringTurn ? "stopped" : turn.state,
          lastActivity: nowIso(),
          warnings: dedupeWarnings([...warnings, ...turn.warnings]),
          ...(sessionSkills.length > 0 ? { skills: sessionSkills } : {}),
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
          handle: {
            runtimeSessionName: params.name,
            cwd: directory,
            agent: params.agent,
            mode: "persistent"
          },
          ...(stoppedDuringTurn ? { lastStopReason: "stopped by user" } : {})
        };

        await this.deps.store.upsertSession(nextSession);
        this.recordTurnUsage(nextSession, turn);
        return textToolResult(`Started session ${params.name}.`, {
          session: nextSession,
          output: turn.output,
          outputRole: outputRoleForTurn(turn),
          ...(turn.signals != null ? { turnSignals: turn.signals } : {}),
          contextFiles: context.files,
          skills: installedSkills
        });
      } catch (error) {
        if (this.deps.store.getActiveQuiescenceEpoch(params.name) == null) {
          await this.deps.store.upsertSession({
            ...provisionalSession,
            state: "failed",
            lastActivity: nowIso(),
            lastError: ensureError(error).message
          });
        }
        throw error;
      }
    });
  }

  async send(params: SendParams): Promise<ToolResult> {
    return await this.withSessionTurnLock(params.name, params.lifecycleEpoch, async () => {
      const storedSession = this.requireSession(params.name);
      const providerRefresh = await this.prepareModelProviderRefresh(storedSession, params);
      const session = providerRefresh.session;
      const requestedSession =
        params.effort == null ? session : { ...session, effort: params.effort };
      const reasoning = this.resolveSessionReasoning(requestedSession);
      const effectiveSession = reasoning.session;
      if (providerRefresh.refreshed) {
        // Persist the daemon-validated provider selection before launching the
        // external turn. A failed provider turn must not make the next retry
        // silently fall back to stale endpoint or model metadata.
        await this.deps.store.upsertSession(effectiveSession);
      }
      if (!isConnectedSession(session)) {
        await this.ensureConnectedCapacity(params.name);
      }
      if (!this.usesOneShotRuntime(effectiveSession)) {
        await this.ensureRuntimeSession({
          name: effectiveSession.name,
          agent: effectiveSession.agent,
          directory: effectiveSession.directory,
          ...(effectiveSession.model != null ? { model: effectiveSession.model } : {}),
          ...(effectiveSession.runtimeEffort != null
            ? { effort: effectiveSession.runtimeEffort }
            : {}),
          ...(effectiveSession.modelProvider != null
            ? { modelProvider: effectiveSession.modelProvider }
            : {})
        });
      }
      const context = await loadContextFiles(session.directory, params.contextFiles);
      const prefix =
        effectiveSession.effort == null && params.ultrathink === true
          ? effectiveSession.reasoningProfile === "claude"
            ? "ultrathink\n\n"
            : "Use a high-effort reasoning pass for this reply.\n\n"
          : "";
      const promptText = [
        interactionPromptPrefix(params.interactionMode),
        prefix + params.message.trim(),
        context.promptText
      ]
        .filter(Boolean)
        .join("\n\n");
      const runtimePromptText =
        session.state === "suspended"
          ? this.buildRehydrationPrompt(session, promptText)
          : promptText;
      const effectivePromptText = this.usesOneShotRuntime(effectiveSession)
        ? this.buildOneShotContinuationPrompt(effectiveSession, runtimePromptText)
        : runtimePromptText;
      const effectivePermissionMode =
        params.permissionMode ?? this.effectivePermissionMode(session);
      const turn = await this.runTurn({
        session: effectiveSession,
        promptText: effectivePromptText,
        permissionMode: effectivePermissionMode,
        ...(params.interactionMode != null ? { interactionMode: params.interactionMode } : {})
      });
      const stoppedDuringTurn = this.stopRequests.delete(params.name);

      const nextSession: SessionInfo = {
        ...effectiveSession,
        permissionMode:
          params.permissionMode == null ? effectivePermissionMode : session.permissionMode,
        state: stoppedDuringTurn ? "stopped" : turn.state,
        lastActivity: nowIso(),
        warnings: dedupeWarnings([
          ...session.warnings,
          ...(reasoning.warning != null ? [reasoning.warning] : []),
          ...turn.warnings
        ]),
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
      this.recordTurnUsage(nextSession, turn);
      return textToolResult(`Updated session ${params.name}.`, {
        session: nextSession,
        output: turn.output,
        outputRole: outputRoleForTurn(turn),
        ...(turn.signals != null ? { turnSignals: turn.signals } : {}),
        contextFiles: context.files
      });
    });
  }

  async stop(params: StopParams): Promise<ToolResult> {
    this.deps.store.assertSessionMutable(params.name);
    const session = this.requireSession(params.name);
    const runtimeEnv = this.modelProviderRuntimeEnv(session.modelProvider);
    this.stopRequests.add(params.name);
    const hadActiveTurn = this.activeTurns.has(params.name);
    await this.runControlCommand({
      args: this.buildVerbArgs(session.agent, session.directory, [
        "cancel",
        "--session",
        session.name
      ]),
      cwd: session.directory,
      ...(runtimeEnv != null ? { env: runtimeEnv } : {})
    }).catch(() => {
      // best-effort cancel
    });
    const signalledChild = this.terminateActiveTurnProcess(params.name, "SIGTERM");
    if (signalledChild != null) {
      const forceKillTimer = setTimeout(() => {
        // Identity-guarded: if the SIGTERM'd child exited quickly and a new
        // turn already registered its own process under this session name,
        // this delayed SIGKILL must not hit the new turn's process.
        this.terminateActiveTurnProcess(params.name, "SIGKILL", signalledChild);
      }, 2_000);
      forceKillTimer.unref();
    }

    const nextSession: SessionInfo = {
      ...withoutFocusLease(session),
      state: "stopped",
      lastActivity: nowIso(),
      lastStopReason: "stopped by user"
    };
    await this.deps.store.upsertSession(nextSession);
    if (!hadActiveTurn) {
      this.stopRequests.delete(params.name);
    }
    return textToolResult(`Stopped session ${params.name}.`, {
      session: nextSession
    });
  }

  async resume(params: ResumeParams): Promise<ToolResult> {
    return await this.withLifecycleLock(params.name, async () => {
      this.deps.store.assertSessionMutable(params.name);
      const storedSession = this.requireSession(params.name);
      const reasoning = this.resolveSessionReasoning(storedSession);
      const session = reasoning.session;
      if (!isConnectedSession(session)) {
        await this.ensureConnectedCapacity(session.name);
      }
      if (!this.usesOneShotRuntime(session)) {
        await this.ensureRuntimeSession({
          name: session.name,
          agent: session.agent,
          directory: session.directory,
          ...(session.model != null ? { model: session.model } : {}),
          ...(session.runtimeEffort != null ? { effort: session.runtimeEffort } : {}),
          ...(session.modelProvider != null ? { modelProvider: session.modelProvider } : {})
        });
      }
      const nextSession: SessionInfo = {
        ...session,
        state: "idle",
        warnings: dedupeWarnings([
          ...session.warnings,
          ...(reasoning.warning != null ? [reasoning.warning] : [])
        ])
      };
      await this.deps.store.upsertSession(nextSession);
      return textToolResult(`Resumed session ${params.name}.`, {
        session: nextSession
      });
    });
  }

  async suspend(params: SuspendParams): Promise<ToolResult> {
    this.deps.store.assertSessionMutable(params.name);
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
    this.deps.store.assertSessionMutable(params.name);
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
    this.deps.store.assertSessionMutable(params.name);
    const session = this.requireSession(params.name);
    const nextSession = withoutFocusLease(session);
    await this.deps.store.upsertSession(nextSession);
    return textToolResult(`Unfocused session ${params.name}.`, {
      session: nextSession
    });
  }

  async fork(params: ForkParams): Promise<ToolResult> {
    return await this.withLifecycleLock(params.source, async () => {
      this.deps.store.assertSessionMutable(params.source);
      this.deps.store.assertSessionMutable(params.target);
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

      const startParams: StartParams = {
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
      };
      if (source.modelProviderId != null) {
        startParams.modelProviderId = source.modelProviderId;
      }
      if (source.modelProvider != null) {
        startParams.modelProvider = source.modelProvider;
      }
      const result = await this.start(startParams);
      return textToolResult(`Forked ${params.source} into ${params.target}.`, result.details);
    });
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
    const activeQuiescence = this.deps.store.getQuiescence(session.name);
    const runtimeStatus =
      activeQuiescence != null
        ? { exists: false, status: "quiesced" }
        : await this.getRuntimeStatus({
            name: session.name,
            agent: session.agent,
            directory: session.directory,
            ...(session.modelProvider != null ? { modelProvider: session.modelProvider } : {})
          });
    const details = {
      session,
      runtime: runtimeStatus,
      ...(activeQuiescence != null
        ? { lifecycle: { quiesced: true, epoch: activeQuiescence.epoch } }
        : {})
    };
    return jsonToolResult(details, `Status for ${params.name}`);
  }

  async output(params: StatusParams): Promise<ToolResult> {
    if (params.name == null) {
      throw new PuppenclawError("MISSING_SESSION", "Session name is required.");
    }
    const session = this.requireSession(params.name);
    const active = this.activeTurnOutputs.get(params.name);
    const runningActive = active != null && !active.complete ? active : undefined;
    const latestTranscriptOutput = [...session.transcript]
      .reverse()
      .find(
        (entry) =>
          (entry.role === "assistant" || entry.role === "status") && entry.text.trim().length > 0
      );
    const activeHasText = active != null && active.text.trim().length > 0;
    const useActive =
      runningActive != null ||
      (activeHasText &&
        (latestTranscriptOutput == null ||
          Date.parse(active.updatedAt) >= Date.parse(latestTranscriptOutput.createdAt) - 5_000 ||
          session.state === "failed"));
    const text = useActive
      ? (active?.text ?? "")
      : (latestTranscriptOutput?.text ?? active?.text ?? "");
    return jsonToolResult(
      {
        session: this.decorateVisibleSession(session),
        output: {
          text,
          chars: text.length,
          source:
            useActive && active != null
              ? "active-turn"
              : latestTranscriptOutput != null
                ? "transcript"
                : "none",
          startedAt: useActive ? (active?.startedAt ?? null) : null,
          updatedAt: useActive
            ? (active?.updatedAt ?? null)
            : (latestTranscriptOutput?.createdAt ?? null),
          complete: runningActive?.complete ?? session.state !== "running"
        }
      },
      `Output for ${params.name}`
    );
  }

  async cost(params: CostParams = {}): Promise<ToolResult> {
    if (params.name == null) {
      return this.usageRollup(params);
    }
    const session = this.requireSession(params.name);
    const totals = this.deps.ledger?.perSessionTotals(session.name) ?? null;
    const history = this.deps.ledger?.perSessionHistory(session.name, params.limit ?? 20) ?? [];
    const provider = deriveUsageProvider(session);
    const model = deriveUsageModel(session);
    const contextSnapshot =
      session.tokenUsage?.used != null && session.tokenUsage?.size != null
        ? ` Context: ${formatTokenCount(session.tokenUsage.used)}/${formatTokenCount(session.tokenUsage.size)}.`
        : "";
    const summary =
      totals != null && totals.turns > 0
        ? `Usage for session ${session.name} (${provider} ${model}): ${totals.turns} turn${
            totals.turns === 1 ? "" : "s"
          }, ${formatUsageLine(totals.usage)}.${contextSnapshot}`
        : `Usage for session ${session.name}: no recorded token counters yet.${contextSnapshot}`;
    return textToolResult(summary, {
      name: session.name,
      provider,
      model,
      lastCall: session.tokenUsage ?? null,
      totals,
      turns: totals?.turns ?? 0,
      history,
      pricing: null,
      note: "Puppenclaw records token counters when the ACP runtime emits them. It does not infer currency pricing."
    });
  }

  private usageRollup(params: CostParams): ToolResult {
    const ledger = this.deps.ledger;
    const scope = params.since != null ? `since ${params.since}` : "all recorded sessions";
    const note =
      "Puppenclaw records token counters when the ACP runtime emits them. It does not infer currency pricing.";
    if (ledger == null) {
      return textToolResult(
        `Usage rollup (${scope}): no usage ledger is configured, so no token counters are recorded.`,
        {
          rollup: [],
          totals: null,
          since: params.since ?? null,
          pricing: null,
          note
        }
      );
    }
    const rollup = ledger.perModelRollup(params.since);
    const totals = ledger.grandTotals(params.since);
    const lines = rollup.map(
      (entry) =>
        `${entry.provider}/${entry.model}: ${entry.turns} turn${entry.turns === 1 ? "" : "s"}, ${formatUsageLine(entry.usage)}`
    );
    const summary =
      totals.turns > 0
        ? [
            `Usage rollup (${scope}):`,
            ...lines,
            `TOTAL: ${totals.turns} turn${totals.turns === 1 ? "" : "s"}, ${formatUsageLine(totals.usage)}`
          ].join("\n")
        : `Usage rollup (${scope}): no recorded token counters yet.`;
    return textToolResult(summary, {
      rollup,
      totals,
      since: params.since ?? null,
      pricing: null,
      note
    });
  }

  async purge(params: StopParams): Promise<ToolResult> {
    return await this.withLifecycleLock(params.name, async () => {
      const existingReservation = this.deps.store.getQuiescence(params.name);
      const locallyTrackedTurn =
        this.activeTurns.has(params.name) || this.activeTurnProcesses.has(params.name);
      if (this.deps.store.getSession(params.name) == null) {
        if (existingReservation != null && existingReservation.purpose === "purge") {
          await this.deps.store.releaseQuiescence(params.name, existingReservation.epoch);
          this.stopRequests.delete(params.name);
          return textToolResult(`Session ${params.name} was already purged.`, {
            sessionName: params.name,
            purged: true,
            alreadyAbsent: true,
            quiescenceEpoch: existingReservation.epoch,
            transientFence: true
          });
        }
        if (!locallyTrackedTurn) {
          throw new PuppenclawError("NO_SESSION", `Unknown session ${params.name}.`, {
            name: params.name,
            transientFence: existingReservation == null
          });
        }
      }
      const reservation = await this.deps.store.reserveQuiescence(params.name, "purge");
      const epoch = reservation.epoch;
      const session = this.deps.store.getSession(params.name);
      if (session != null) {
        await this.closeQuiescedRuntime(session, epoch, { locallyTrackedTurn });
      } else {
        const startedSession = await this.drainUnknownQuiescedTurn(params.name, epoch);
        if (startedSession != null) {
          await this.closeQuiescedRuntime(startedSession, epoch, {
            locallyTrackedTurn: true
          });
        }
      }
      await this.deps.store.removeSession(params.name);
      this.deps.outputRouter.clear(params.name);
      this.activeTurnOutputs.delete(params.name);
      this.activeTurnProcesses.delete(params.name);
      this.stopRequests.delete(params.name);
      if (reservation.purpose === "purge") {
        await this.deps.store.releaseQuiescence(params.name, epoch);
      }
      return textToolResult(`Purged session ${params.name}.`, {
        sessionName: params.name,
        purged: true,
        quiescenceEpoch: epoch,
        transientFence: reservation.purpose === "purge"
      });
    });
  }

  async quiesce(params: QuiesceParams): Promise<ToolResult> {
    return await this.withLifecycleLock(params.name, async () => {
      const reservation = await this.deps.store.reserveQuiescence(params.name, "external");
      const epoch = reservation.epoch;
      const locallyTrackedTurn =
        this.activeTurns.has(params.name) || this.activeTurnProcesses.has(params.name);
      const session = this.deps.store.getSession(params.name);
      if (session != null) {
        await this.closeQuiescedRuntime(session, epoch, { locallyTrackedTurn });
      } else if (locallyTrackedTurn) {
        const startedSession = await this.drainUnknownQuiescedTurn(params.name, epoch);
        if (startedSession != null) {
          await this.closeQuiescedRuntime(startedSession, epoch, {
            locallyTrackedTurn: true
          });
        }
      }
      return textToolResult(`Quiesced session ${params.name}.`, {
        ...(session != null ? { session: this.decorateVisibleSession(session) } : {}),
        reservation: {
          name: params.name,
          epoch
        },
        quiescenceEpoch: epoch,
        runtimeClosed: true
      });
    });
  }

  async releaseQuiescence(params: QuiescenceReleaseParams): Promise<ToolResult> {
    return await this.withLifecycleLock(params.name, async () => {
      await this.deps.store.releaseQuiescence(params.name, params.epoch);
      this.stopRequests.delete(params.name);
      return textToolResult(`Released quiescence for session ${params.name}.`, {
        reservation: {
          name: params.name,
          epoch: params.epoch
        },
        quiescenceEpoch: params.epoch,
        released: true
      });
    });
  }

  async gc(): Promise<void> {
    const now = Date.now();
    const ttlMs = this.deps.config.sessionTtlMinutes * 60_000;
    for (const session of this.deps.store.listSessions()) {
      if (!["failed", "completed", "stopped"].includes(session.state)) {
        continue;
      }
      // The stored state/lastActivity are only updated when a turn FINISHES,
      // so a session with an in-flight turn can look terminal and expired
      // here. Never close/remove a session while a turn is running: consult
      // the in-memory turn lock and the live turn-process registry.
      if (this.activeTurns.has(session.name) || this.activeTurnProcesses.has(session.name)) {
        continue;
      }
      const ageMs = now - Date.parse(session.lastActivity);
      if (!Number.isFinite(ageMs) || ageMs < ttlMs) {
        continue;
      }
      await this.purge({ name: session.name }).catch((error) => {
        this.deps.logger.warn(
          `Unable to purge expired session ${session.name}: ${ensureError(error).message}`
        );
      });
    }
  }

  private async withSessionTurnLock<T>(
    name: string,
    lifecycleEpoch: number | undefined,
    run: () => Promise<T>
  ): Promise<T> {
    await this.withLifecycleLock(name, async () => {
      if (this.activeTurns.has(name)) {
        throw new PuppenclawError(
          "TURN_ALREADY_RUNNING",
          `Session ${name} is already running a turn.`
        );
      }
      await this.deps.store.enterLifecycleTurn(name, lifecycleEpoch);
      this.activeTurns.add(name);
      this.stopRequests.delete(name);
    });
    try {
      return await run();
    } finally {
      this.activeTurns.delete(name);
    }
  }

  private async withLifecycleLock<T>(name: string, run: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTails.get(name) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(run);
    const tail = operation.then(
      () => undefined,
      () => undefined
    );
    this.lifecycleTails.set(name, tail);
    try {
      return await operation;
    } finally {
      if (this.lifecycleTails.get(name) === tail) {
        this.lifecycleTails.delete(name);
      }
    }
  }

  private async closeQuiescedRuntime(
    session: SessionInfo,
    epoch: number,
    options: { locallyTrackedTurn?: boolean } = {}
  ): Promise<void> {
    const oneShotRuntime = this.usesOneShotRuntime(session);
    const locallyTrackedTurn =
      options.locallyTrackedTurn ??
      (this.activeTurns.has(session.name) || this.activeTurnProcesses.has(session.name));
    this.stopRequests.add(session.name);
    const runtimeEnv = this.modelProviderRuntimeEnv(session.modelProvider);
    this.terminateActiveTurnProcess(session.name, "SIGTERM");
    await this.runControlCommand({
      args: this.buildVerbArgs(session.agent, session.directory, [
        "cancel",
        "--session",
        session.name
      ]),
      cwd: session.directory,
      timeoutMs: QUIESCENCE_CONTROL_TIMEOUT_MS,
      ...(runtimeEnv != null ? { env: runtimeEnv } : {})
    }).catch((error) => {
      this.deps.logger.debug(
        `Unable to cancel quiesced session ${session.name}: ${ensureError(error).message}`
      );
    });

    const drained = await this.waitForActiveTurnDrain(session.name);
    if (!drained) {
      throw new PuppenclawError(
        "QUIESCENCE_UNAVAILABLE",
        `Session ${session.name} did not drain for quiescence epoch ${epoch}.`,
        { name: session.name, quiescenceEpoch: epoch }
      );
    }

    if (oneShotRuntime) {
      if (session.state === "running" && !locallyTrackedTurn) {
        throw new PuppenclawError(
          "QUIESCENCE_UNAVAILABLE",
          `Direct one-shot runtime closure cannot be proved for session ${session.name} after manager restart.`,
          { name: session.name, quiescenceEpoch: epoch }
        );
      }
      await this.recordQuiescedSessionState(session.name, epoch);
      return;
    }

    await this.runControlCommand({
      args: this.buildVerbArgs(session.agent, session.directory, [
        "sessions",
        "close",
        session.name
      ]),
      cwd: session.directory,
      allowNoSession: true,
      timeoutMs: QUIESCENCE_CONTROL_TIMEOUT_MS,
      ...(runtimeEnv != null ? { env: runtimeEnv } : {})
    }).catch((error) => {
      this.deps.logger.debug(
        `Unable to close quiesced session ${session.name}: ${ensureError(error).message}`
      );
    });

    const deadline = Date.now() + QUIESCENCE_CONTROL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = await this.getRuntimeStatus({
        name: session.name,
        agent: session.agent,
        directory: session.directory,
        timeoutMs: QUIESCENCE_CONTROL_TIMEOUT_MS,
        ...(session.modelProvider != null ? { modelProvider: session.modelProvider } : {})
      }).catch(() => ({ exists: true }));
      if (!status.exists) {
        await this.recordQuiescedSessionState(session.name, epoch);
        return;
      }
      await sleep(QUIESCENCE_POLL_MS);
    }
    throw new PuppenclawError(
      "QUIESCENCE_UNAVAILABLE",
      `ACP runtime closure could not be proved for session ${session.name}.`,
      { name: session.name, quiescenceEpoch: epoch }
    );
  }

  private async drainUnknownQuiescedTurn(
    name: string,
    epoch: number
  ): Promise<SessionInfo | null> {
    this.stopRequests.add(name);
    this.terminateActiveTurnProcess(name, "SIGTERM");
    const drained = await this.waitForActiveTurnDrain(name);
    if (!drained) {
      throw new PuppenclawError(
        "QUIESCENCE_UNAVAILABLE",
        `Initial start for session ${name} did not drain for quiescence epoch ${epoch}.`,
        { name, quiescenceEpoch: epoch }
      );
    }
    return this.deps.store.getSession(name);
  }

  private async recordQuiescedSessionState(name: string, epoch: number): Promise<void> {
    await this.deps.store.patchQuiescedSession(name, epoch, (current) => ({
      ...withoutFocusLease(current),
      state: "stopped",
      lastActivity: nowIso(),
      lastStopReason: `quiesced at lifecycle epoch ${epoch}`
    }));
  }

  private async waitForActiveTurnDrain(name: string): Promise<boolean> {
    const deadline = Date.now() + QUIESCENCE_DRAIN_TIMEOUT_MS;
    const escalationAt = Date.now() + Math.min(1_000, QUIESCENCE_DRAIN_TIMEOUT_MS / 2);
    while (Date.now() < deadline) {
      if (!this.activeTurns.has(name) && !this.activeTurnProcesses.has(name)) {
        return true;
      }
      const signal = Date.now() >= escalationAt ? "SIGKILL" : "SIGTERM";
      this.terminateActiveTurnProcess(name, signal);
      await sleep(QUIESCENCE_POLL_MS);
    }
    return !this.activeTurns.has(name) && !this.activeTurnProcesses.has(name);
  }

  private isTurnActive(session: SessionInfo): boolean {
    return this.activeTurns.has(session.name) || session.state === "running";
  }

  private decorateVisibleSession(session: SessionInfo): SessionInfo {
    const activeQuiescence = this.deps.store.getQuiescence(session.name);
    if (activeQuiescence != null) {
      return {
        ...session,
        state: "stopped",
        lastStopReason: `quiesced at lifecycle epoch ${activeQuiescence.epoch}`
      };
    }
    if (this.stopRequests.has(session.name)) {
      return session;
    }
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

  private async suspendTrackedSession(session: SessionInfo, reason: string): Promise<SessionInfo> {
    const runtimeEnv = this.modelProviderRuntimeEnv(session.modelProvider);
    await this.runControlCommand({
      args: this.buildVerbArgs(session.agent, session.directory, [
        "sessions",
        "close",
        session.name
      ]),
      cwd: session.directory,
      ...(runtimeEnv != null ? { env: runtimeEnv } : {})
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
    return [
      `This Puppenclaw session ${session.name} was disconnected from the ACP runtime to free a worker slot.`,
      "Rehydrate the following transcript as prior context. Do not repeat it to the user unless needed.",
      "The full stored transcript is included. If it cannot fit in the active model context, explicitly report that context-size limit instead of silently ignoring earlier turns.",
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
    modelProviderId?: string;
    modelProvider?: ModelProviderConfig;
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
      ...(params.modelProviderId != null ? { modelProviderId: params.modelProviderId } : {}),
      ...(params.modelProvider != null ? { modelProvider: params.modelProvider } : {}),
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

  private effectivePermissionMode(session: SessionInfo): PermissionMode {
    return session.permissionMode;
  }

  private resolveSessionReasoning(session: SessionInfo): {
    session: SessionInfo;
    warning?: string;
  } {
    const profile = reasoningProfileFor(session);
    if (session.effort == null) {
      return {
        session: {
          ...session,
          reasoningProfile: profile
        }
      };
    }
    const resolution = resolveReasoningMode(session, session.effort);
    if (resolution == null) {
      if (profile === "claude" && session.effort === "ultracode") {
        throw new PuppenclawError(
          "UNAVAILABLE_REASONING_MODE",
          "Claude Ultracode is exposed as a future workflow capability, but the current ACP boundary cannot safely execute its approval, progress, background-run, and multiplexing lifecycle.",
          {
            profile,
            requested: session.effort,
            accepted: acceptedReasoningModes(profile)
          }
        );
      }
      throw new PuppenclawError(
        "UNSUPPORTED_REASONING_MODE",
        `Reasoning mode "${session.effort}" is not supported by the ${profile} profile.`,
        {
          profile,
          requested: session.effort,
          accepted: acceptedReasoningModes(profile)
        }
      );
    }
    return {
      session: {
        ...session,
        reasoningProfile: resolution.profile,
        effectiveEffort: resolution.effective,
        runtimeEffort: resolution.runtimeValue
      },
      ...(resolution.warning != null ? { warning: resolution.warning } : {})
    };
  }

  private modelProviderRuntimeEnv(
    modelProvider: ModelProviderConfig | undefined
  ): NodeJS.ProcessEnv | undefined {
    if (modelProvider == null) {
      return undefined;
    }
    return {
      PUPPENCLAW_MODEL_PROVIDER_ID: modelProvider.id,
      PUPPENCLAW_MODEL_PROVIDER_MODEL: modelProvider.model,
      ...(modelProvider.label != null
        ? { PUPPENCLAW_MODEL_PROVIDER_LABEL: modelProvider.label }
        : {}),
      ...(modelProvider.kind != null ? { PUPPENCLAW_MODEL_PROVIDER_KIND: modelProvider.kind } : {}),
      ...(modelProvider.baseUrl != null
        ? { PUPPENCLAW_MODEL_PROVIDER_BASE_URL: modelProvider.baseUrl }
        : {}),
      ...(modelProvider.authTokenEnv != null
        ? { PUPPENCLAW_MODEL_PROVIDER_AUTH_TOKEN_ENV: modelProvider.authTokenEnv }
        : {}),
      ...(modelProvider.wireApi != null
        ? { PUPPENCLAW_MODEL_PROVIDER_WIRE_API: modelProvider.wireApi }
        : {}),
      ...(modelProvider.reasoningProfile != null
        ? { PUPPENCLAW_MODEL_PROVIDER_REASONING_PROFILE: modelProvider.reasoningProfile }
        : {})
    };
  }

  private usesOneShotRuntime(session: {
    agent: AgentKind;
    modelProvider?: ModelProviderConfig;
  }): boolean {
    return session.agent === "codex" && session.modelProvider != null;
  }

  private async prepareModelProviderRefresh(
    session: SessionInfo,
    params: Pick<SendParams, "modelProviderId" | "modelProvider">
  ): Promise<{ session: SessionInfo; refreshed: boolean }> {
    const requestedId = params.modelProviderId;
    const requestedProvider = params.modelProvider;
    if (requestedId == null && requestedProvider == null) {
      return { session, refreshed: false };
    }
    if (requestedId == null || requestedProvider == null) {
      throw new PuppenclawError(
        "MODEL_PROVIDER_REFRESH_INVALID",
        "A daemon model-provider refresh requires both modelProviderId and modelProvider."
      );
    }
    if (requestedId !== requestedProvider.id) {
      throw new PuppenclawError(
        "MODEL_PROVIDER_REFRESH_INVALID",
        "modelProviderId must exactly match modelProvider.id."
      );
    }
    if (
      session.agent !== "codex" ||
      !["codex-openai", "codex-openai-compatible"].includes(requestedProvider.kind ?? "")
    ) {
      throw new PuppenclawError(
        "MODEL_PROVIDER_REFRESH_UNSUPPORTED",
        "Model-provider refresh is restricted to Codex one-shot providers."
      );
    }

    const storedIds = [session.modelProviderId, session.modelProvider?.id].filter(
      (value): value is string => value != null
    );
    if (storedIds.some((storedId) => storedId !== requestedId)) {
      throw new PuppenclawError(
        "MODEL_PROVIDER_REFRESH_CONFLICT",
        `Session ${session.name} is already bound to a different model provider.`
      );
    }

    if (session.modelProvider == null) {
      await this.closeLegacyRuntimeForProviderRefresh(session);
    }

    return {
      session: {
        ...session,
        model: requestedProvider.model,
        modelProviderId: requestedId,
        modelProvider: requestedProvider
      },
      refreshed: true
    };
  }

  private async closeLegacyRuntimeForProviderRefresh(session: SessionInfo): Promise<void> {
    const status = await this.getRuntimeStatus({
      name: session.name,
      agent: session.agent,
      directory: session.directory,
      timeoutMs: QUIESCENCE_CONTROL_TIMEOUT_MS
    });
    if (!status.exists || status.status === "dead") {
      return;
    }

    await this.runControlCommand({
      args: this.buildVerbArgs(session.agent, session.directory, [
        "sessions",
        "close",
        session.name
      ]),
      cwd: session.directory,
      allowNoSession: true,
      timeoutMs: QUIESCENCE_CONTROL_TIMEOUT_MS
    });
    const closedStatus = await this.getRuntimeStatus({
      name: session.name,
      agent: session.agent,
      directory: session.directory,
      timeoutMs: QUIESCENCE_CONTROL_TIMEOUT_MS
    });
    if (closedStatus.exists && closedStatus.status !== "dead") {
      throw new PuppenclawError(
        "MODEL_PROVIDER_REFRESH_UNSAFE",
        `Persistent ACP runtime ${session.name} remained active; provider refresh was not applied.`
      );
    }
  }

  private buildOneShotContinuationPrompt(session: SessionInfo, promptText: string): string {
    if (session.transcript.length === 0) {
      return promptText;
    }
    const transcript = session.transcript
      .map((entry) => `${entry.role.toUpperCase()}: ${entry.text}`)
      .join("\n\n");
    return [
      "Continue the existing Puppenclaw session using the transcript below as prior context.",
      "The full stored transcript is included. If it cannot fit in the active model context, explicitly report that context-size limit instead of silently ignoring earlier turns.",
      `Session name: ${session.name}`,
      "",
      "Prior transcript:",
      transcript,
      "",
      "New request:",
      promptText
    ].join("\n");
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
        `Requested model override "${params.model}" is forwarded to the selected agent runtime.`
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
      warnings.push(`Using configured raw agent command for ${params.agent}.`);
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
    effort?: EffortLevel;
    modelProvider?: ModelProviderConfig;
  }): Promise<void> {
    const runtimeEnv = this.modelProviderRuntimeEnv(params.modelProvider);
    const status = await this.getRuntimeStatus(params);
    const createdRuntime = !status.exists || status.status === "dead";
    if (createdRuntime) {
      const args = this.buildVerbArgs(params.agent, params.directory, [
        "sessions",
        "new",
        "--name",
        params.name
      ]);
      await this.runControlCommand({
        args,
        cwd: params.directory,
        ...(runtimeEnv != null ? { env: runtimeEnv } : {})
      });
    }
    if (params.model != null) {
      await this.runControlCommand({
        args: this.buildVerbArgs(params.agent, params.directory, [
          "set",
          "model",
          params.model,
          "--session",
          params.name
        ]),
        cwd: params.directory,
        ...(runtimeEnv != null ? { env: runtimeEnv } : {})
      }).catch((error) => {
        this.deps.logger.warn(
          `Unable to set ACPX model for session ${params.name}: ${ensureError(error).message}`
        );
      });
    }
    if (params.effort != null) {
      const effortConfigId = params.agent === "claude" ? "effort" : "reasoning_effort";
      await this.runControlCommand({
        args: this.buildVerbArgs(params.agent, params.directory, [
          "set",
          effortConfigId,
          params.effort,
          "--session",
          params.name
        ]),
        cwd: params.directory,
        ...(runtimeEnv != null ? { env: runtimeEnv } : {})
      }).catch(async (error) => {
        const cause = ensureError(error).message;
        if (createdRuntime) {
          await this.runControlCommand({
            args: this.buildVerbArgs(params.agent, params.directory, [
              "sessions",
              "close",
              params.name
            ]),
            cwd: params.directory,
            ...(runtimeEnv != null ? { env: runtimeEnv } : {})
          }).catch(() => {
            // Best-effort cleanup of a runtime that never became usable.
          });
        }
        if (isReasoningOptionRejection(error)) {
          throw new PuppenclawError(
            "UNSUPPORTED_REASONING_MODE",
            `ACP runtime rejected reasoning mode "${params.effort}" for session ${params.name}: ${cause}`,
            {
              agent: params.agent,
              requested: params.effort
            }
          );
        }
        throw error;
      });
    }
    await this.waitForRuntimeSessionReady(params);
  }

  private async waitForRuntimeSessionReady(params: {
    name: string;
    agent: AgentKind;
    directory: string;
    modelProvider?: ModelProviderConfig;
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
    modelProvider?: ModelProviderConfig;
    timeoutMs?: number;
  }): Promise<RuntimeStatus> {
    const runtimeEnv = this.modelProviderRuntimeEnv(params.modelProvider);
    const result = await this.runControlCommand({
      args: this.buildVerbArgs(params.agent, params.directory, [
        "status",
        "--session",
        params.name
      ]),
      cwd: params.directory,
      ...(runtimeEnv != null ? { env: runtimeEnv } : {}),
      allowNoSession: true,
      ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {})
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
      ...(detail != null
        ? { status: asOptionalString(detail.status) ?? "unknown", raw: detail }
        : {})
    };
  }

  private async getRuntimeSessionRecord(session: SessionInfo): Promise<JsonRecord | null> {
    const runtimeEnv = this.modelProviderRuntimeEnv(session.modelProvider);
    const result = await this.runControlCommand({
      args: this.buildVerbArgs(session.agent, session.directory, [
        "sessions",
        "show",
        session.name
      ]),
      cwd: session.directory,
      ...(runtimeEnv != null ? { env: runtimeEnv } : {})
    });
    return parseJsonLines(result.stdout).find((event) => toErrorRecord(event) == null) ?? null;
  }

  private async getRuntimeMessageCount(session: SessionInfo): Promise<number | undefined> {
    const record = await this.getRuntimeSessionRecord(session);
    return record != null ? readMessages(record).length : undefined;
  }

  private async getRuntimeSessionHistory(session: SessionInfo): Promise<JsonRecord | null> {
    const runtimeEnv = this.modelProviderRuntimeEnv(session.modelProvider);
    const result = await this.runControlCommand({
      args: this.buildVerbArgs(session.agent, session.directory, [
        "sessions",
        "history",
        "--limit",
        "8",
        session.name
      ]),
      cwd: session.directory,
      ...(runtimeEnv != null ? { env: runtimeEnv } : {})
    });
    return parseJsonLines(result.stdout).find((event) => toErrorRecord(event) == null) ?? null;
  }

  private async waitForDelayedAssistantOutput(params: {
    session: SessionInfo;
    afterMessageCount: number | undefined;
    sinceMs: number;
  }): Promise<string | undefined> {
    const deadline = Date.now() + RECONNECT_HISTORY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const record = await this.getRuntimeSessionRecord(params.session);
        const output = extractLatestAgentText(record, params.afterMessageCount);
        if (output != null) {
          return output;
        }
        const history = await this.getRuntimeSessionHistory(params.session);
        const historyOutput = extractLatestAssistantHistoryText(history, params.sinceMs);
        if (historyOutput != null) {
          return historyOutput;
        }
      } catch (error) {
        this.deps.logger.debug(
          `Waiting for delayed ACPX output for ${params.session.name}: ${ensureError(error).message}`
        );
      }
      await sleep(RECONNECT_HISTORY_POLL_MS);
    }
    return undefined;
  }

  private async prepareNativeInteractionMode(params: {
    session: SessionInfo;
    interactionMode?: InteractionMode;
  }): Promise<NativeModePreparation> {
    if (
      params.interactionMode == null ||
      params.session.agent !== "claude" ||
      this.usesOneShotRuntime(params.session)
    ) {
      return {};
    }

    const sessionRecord = await this.getRuntimeSessionRecord(params.session).catch(() => null);
    const modeStateFromRecord = extractRuntimeModeState(sessionRecord);
    const modeState =
      modeStateFromRecord ??
      extractRuntimeModeState(
        (
          await this.getRuntimeStatus({
            name: params.session.name,
            agent: params.session.agent,
            directory: params.session.directory,
            ...(params.session.modelProvider != null
              ? { modelProvider: params.session.modelProvider }
              : {})
          })
        ).raw
      );
    if (modeState == null) {
      return {
        warning: `ACP runtime did not advertise session modes; ${params.interactionMode} intent is enforced through the prompt and permission boundary.`
      };
    }

    const targetMode =
      params.interactionMode === "plan"
        ? modeState.availableModes == null || modeState.availableModes.includes("plan")
          ? "plan"
          : undefined
        : modeState.currentMode === "plan"
          ? (modeState.availableModes?.find((mode) => mode === "default") ??
            modeState.availableModes?.find((mode) => mode === "code") ??
            modeState.availableModes?.find((mode) => mode !== "plan") ??
            (modeState.availableModes == null ? "default" : undefined))
          : modeState.currentMode;
    if (targetMode == null) {
      return {
        activeMode: modeState.currentMode,
        warning: `ACP runtime does not advertise a mode compatible with ${params.interactionMode}; intent is enforced through the prompt and permission boundary.`
      };
    }
    if (targetMode === modeState.currentMode) {
      return { activeMode: modeState.currentMode };
    }

    const runtimeEnv = this.modelProviderRuntimeEnv(params.session.modelProvider);
    try {
      await this.runControlCommand({
        args: this.buildVerbArgs(params.session.agent, params.session.directory, [
          "set-mode",
          targetMode,
          "--session",
          params.session.name
        ]),
        cwd: params.session.directory,
        ...(runtimeEnv != null ? { env: runtimeEnv } : {})
      });
    } catch (error) {
      const advertised = modeState.availableModes?.includes(targetMode) === true;
      if (!advertised && params.interactionMode === "plan") {
        return {
          activeMode: modeState.currentMode,
          warning: `ACP runtime did not advertise plan mode and rejected a capability probe; plan intent is enforced through the prompt and permission boundary.`
        };
      }
      throw new PuppenclawError(
        "ACP_MODE_SWITCH_FAILED",
        `ACP runtime advertised mode "${targetMode}" but rejected the transition for session ${params.session.name}: ${ensureError(error).message}`,
        {
          name: params.session.name,
          requestedMode: targetMode,
          previousMode: modeState.currentMode
        }
      );
    }
    return {
      activeMode: targetMode,
      restoreMode: modeState.currentMode
    };
  }

  private async restoreNativeInteractionMode(
    session: SessionInfo,
    preparation: NativeModePreparation
  ): Promise<void> {
    if (preparation.restoreMode == null || preparation.restoreMode === preparation.activeMode) {
      return;
    }
    const runtimeEnv = this.modelProviderRuntimeEnv(session.modelProvider);
    await this.runControlCommand({
      args: this.buildVerbArgs(session.agent, session.directory, [
        "set-mode",
        preparation.restoreMode,
        "--session",
        session.name
      ]),
      cwd: session.directory,
      ...(runtimeEnv != null ? { env: runtimeEnv } : {})
    });
  }

  private async runTurn(params: {
    session: SessionInfo;
    promptText: string;
    permissionMode: PermissionMode;
    interactionMode?: InteractionMode;
    retryAfterReconnect?: boolean;
    baselineMessageCount?: number;
  }): Promise<TurnResult> {
    const nativeMode = await this.prepareNativeInteractionMode(params);
    let turn: TurnResult;
    try {
      turn = await this.runRuntimeTurn(params);
    } catch (error) {
      await this.restoreNativeInteractionMode(params.session, nativeMode).catch((restoreError) => {
        this.deps.logger.warn(
          `Unable to restore ACP mode for ${params.session.name}: ${ensureError(restoreError).message}`
        );
      });
      throw error;
    }

    const restoreWarning = await this.restoreNativeInteractionMode(params.session, nativeMode).then(
      () => undefined,
      (error) => {
        const message = `Unable to restore ACP mode for ${params.session.name}: ${ensureError(error).message}`;
        this.deps.logger.warn(message);
        return message;
      }
    );
    const signals = mergeTurnSignals(
      nativeMode.activeMode != null ? { nativeMode: nativeMode.activeMode } : undefined,
      turn.signals
    );
    return {
      ...turn,
      warnings: dedupeWarnings([
        ...turn.warnings,
        ...(nativeMode.warning != null ? [nativeMode.warning] : []),
        ...(restoreWarning != null ? [restoreWarning] : [])
      ]),
      ...(signals != null ? { signals } : {})
    };
  }

  private async runRuntimeTurn(params: {
    session: SessionInfo;
    promptText: string;
    permissionMode: PermissionMode;
    interactionMode?: InteractionMode;
    retryAfterReconnect?: boolean;
    baselineMessageCount?: number;
  }): Promise<TurnResult> {
    this.deps.store.assertSessionMutable(params.session.name);
    if (this.usesOneShotRuntime(params.session)) {
      return await this.runCodexOneShotTurn(params);
    }

    const oneShotRuntime = this.usesOneShotRuntime(params.session);
    const baselineMessageCount = oneShotRuntime
      ? undefined
      : (params.baselineMessageCount ??
        (await this.getRuntimeMessageCount(params.session).catch(() => undefined)));
    const promptStartedAtMs = Date.now();
    this.startActiveTurnOutput(params.session.name);
    const args = this.buildVerbArgs(
      params.session.agent,
      params.session.directory,
      oneShotRuntime
        ? ["exec", "--file", "-"]
        : ["prompt", "--session", params.session.name, "--file", "-"],
      true,
      params.permissionMode
    );
    const spawnCommand = resolveSpawnCommand(this.deps.config.acpxCommand ?? "acpx", args);
    const runtimeEnv = this.modelProviderRuntimeEnv(params.session.modelProvider);
    const env = runtimeEnv != null ? { ...process.env, ...runtimeEnv } : process.env;
    const child = spawnCommand.shell
      ? spawn(spawnCommand.command, {
          cwd: params.session.directory,
          stdio: ["pipe", "pipe", "pipe"],
          shell: true,
          detached: process.platform !== "win32",
          env
        })
      : spawn(spawnCommand.command, spawnCommand.args, {
          cwd: params.session.directory,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          env
        });
    this.registerActiveTurnProcess(params.session.name, child);

    // If the child exits or closes stdin before the prompt is fully written
    // (bad auth, oversized prompt, immediate crash), the write surfaces an
    // EPIPE as an 'error' event on stdin. Without a listener that is an
    // UNCAUGHT exception that would crash the whole process, so swallow it
    // here; the turn outcome is decided by the exit code / error events.
    child.stdin.on("error", (error: Error) => {
      this.deps.logger.debug(
        `Puppenclaw prompt stdin error for ${params.session.name}: ${error.message}`
      );
    });
    child.stdin.setDefaultEncoding("utf8");
    child.stdin.write(params.promptText);
    child.stdin.end();

    const events: PromptEvent[] = [];
    const dispatchTasks: Array<Promise<void>> = [];
    const outputChunks: string[] = [];
    let latestTokenUsage: TokenUsage | undefined;
    let latestNormalizedUsage: NormalizedUsage | undefined;
    let pendingStdout = "";
    let stderr = "";
    const recordNormalizedUsage = (usage: NormalizedUsage): void => {
      latestNormalizedUsage = usage;
      latestTokenUsage = {
        ...latestTokenUsage,
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite
      };
    };
    const consumeLine = (line: string): void => {
      const event = parsePromptEventLine(line);
      if (event != null) {
        events.push(event);
        if (event.type === "text_delta" && event.stream === "output") {
          outputChunks.push(event.text);
          this.appendActiveTurnOutput(params.session.name, event.text);
          dispatchTasks.push(this.deps.outputRouter.onChunk(params.session.name, event.text));
        }
        if (event.type === "tool_call") {
          dispatchTasks.push(
            this.deps.outputRouter.onActivity(params.session.name, {
              type: "tool_call",
              title: event.title,
              ...(event.status != null ? { status: event.status } : {}),
              ...(event.toolCallId != null ? { toolCallId: event.toolCallId } : {})
            })
          );
        }
        if (event.type === "plan") {
          dispatchTasks.push(
            this.deps.outputRouter.onActivity(params.session.name, {
              type: "status",
              text: "Agent plan updated."
            })
          );
        }
        if (event.type === "mode") {
          dispatchTasks.push(
            this.deps.outputRouter.onActivity(params.session.name, {
              type: "status",
              text: `Agent mode changed to ${event.mode}.`
            })
          );
        }
        if (event.type === "status") {
          if (event.used != null || event.size != null) {
            latestTokenUsage = {
              ...latestTokenUsage,
              ...(event.used != null ? { used: event.used } : {}),
              ...(event.size != null ? { size: event.size } : {})
            };
          }
          if (event.usage != null && hasNonzeroUsage(event.usage)) {
            recordNormalizedUsage(event.usage);
          }
        }
        if (event.type === "done" && event.usage != null && hasNonzeroUsage(event.usage)) {
          recordNormalizedUsage(event.usage);
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
          this.appendActiveTurnOutput(params.session.name, rawText);
          dispatchTasks.push(this.deps.outputRouter.onChunk(params.session.name, rawText));
        }
        const used = asOptionalFiniteNumber(parsed.used);
        const size = asOptionalFiniteNumber(parsed.size);
        if (used != null || size != null) {
          latestTokenUsage = {
            ...latestTokenUsage,
            ...(used != null ? { used } : {}),
            ...(size != null ? { size } : {})
          };
        }
        const usage = normalizeUsage(parsed);
        if (hasNonzeroUsage(usage)) {
          recordNormalizedUsage(usage);
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
      this.completeActiveTurnOutput(params.session.name);
      throw new PuppenclawError("ACP_TURN_FAILED", ensureError(error).message);
    });

    const trailingLine = pendingStdout.trim();
    if (trailingLine) {
      consumeLine(trailingLine);
    }

    await Promise.all(dispatchTasks);

    const output = outputChunks.join("").trim() || summarizePromptEvents(events).trim();
    const doneEvent = events.findLast(
      (event): event is Extract<PromptEvent, { type: "done" }> => event.type === "done"
    );
    const turnStopReason = doneEvent?.stopReason;
    const promptSignals = signalsFromPromptEvents(events);
    const turnDurationMs = Date.now() - promptStartedAtMs;
    const errorEvent = events.find(
      (event): event is Extract<PromptEvent, { type: "error" }> => event.type === "error"
    );
    const reconnectEvent = events.find(
      (event): event is Extract<PromptEvent, { type: "status" }> =>
        event.type === "status" && /needs reconnect/iu.test(event.text)
    );
    const reconnectText =
      reconnectEvent?.text ??
      (errorEvent != null && /needs reconnect/iu.test(errorEvent.message)
        ? errorEvent.message
        : undefined) ??
      (/needs reconnect/iu.test(stderr) ? stderr.trim() : undefined);
    if (reconnectText != null && !oneShotRuntime) {
      this.deps.logger.warn(
        `ACPX session ${params.session.name} requested reconnect; waiting for delayed assistant output.`
      );
      const delayedOutput = await this.waitForDelayedAssistantOutput({
        session: params.session,
        afterMessageCount: baselineMessageCount,
        sinceMs: promptStartedAtMs
      });
      const recoveredOutput = delayedOutput ?? outputChunks.join("").trim();
      if (recoveredOutput.length > 0) {
        this.deps.logger.info(
          `Recovered delayed ACPX assistant output for ${params.session.name}.`
        );
        const result = await this.finishSuccessfulTurn({
          sessionName: params.session.name,
          output: recoveredOutput,
          ...(promptSignals != null ? { signals: promptSignals } : {}),
          ...(latestTokenUsage != null ? { tokenUsage: latestTokenUsage } : {}),
          ...(latestNormalizedUsage != null ? { usage: latestNormalizedUsage } : {}),
          ...(turnStopReason != null ? { stopReason: turnStopReason } : {}),
          durationMs: turnDurationMs
        });
        this.completeActiveTurnOutput(params.session.name);
        return result;
      }
      if (params.retryAfterReconnect !== true) {
        await this.waitForRuntimeSessionReady({
          name: params.session.name,
          agent: params.session.agent,
          directory: params.session.directory,
          ...(params.session.modelProvider != null
            ? { modelProvider: params.session.modelProvider }
            : {})
        });
        return await this.runRuntimeTurn({
          session: params.session,
          promptText: params.promptText,
          permissionMode: params.permissionMode,
          ...(params.interactionMode != null ? { interactionMode: params.interactionMode } : {}),
          retryAfterReconnect: true,
          ...(baselineMessageCount != null ? { baselineMessageCount } : {})
        });
      }
      await this.deps.outputRouter.onError(params.session.name, new Error(reconnectText));
      this.completeActiveTurnOutput(params.session.name);
      return {
        output: reconnectText,
        warnings: [],
        transcript: [
          {
            role: "status",
            text: reconnectText,
            createdAt: nowIso()
          }
        ],
        state: "failed"
      };
    }
    if (errorEvent != null) {
      this.deps.logger.warn(
        `ACPX session ${params.session.name} returned error event: ${errorEvent.message}`
      );
      await this.deps.outputRouter.onError(params.session.name, new Error(errorEvent.message));
      this.completeActiveTurnOutput(params.session.name);
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
      this.deps.logger.warn(
        `ACPX session ${params.session.name} exited with code ${exitCode ?? "unknown"}: ${message}`
      );
      await this.deps.outputRouter.onError(params.session.name, new Error(message));
      this.completeActiveTurnOutput(params.session.name);
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

    const result = await this.finishSuccessfulTurn({
      sessionName: params.session.name,
      output,
      ...(promptSignals != null ? { signals: promptSignals } : {}),
      ...(latestTokenUsage != null ? { tokenUsage: latestTokenUsage } : {}),
      ...(latestNormalizedUsage != null ? { usage: latestNormalizedUsage } : {}),
      ...(turnStopReason != null ? { stopReason: turnStopReason } : {}),
      durationMs: turnDurationMs
    });
    this.completeActiveTurnOutput(params.session.name);
    return result;
  }

  private async runCodexOneShotTurn(params: {
    session: SessionInfo;
    promptText: string;
    permissionMode: PermissionMode;
    interactionMode?: InteractionMode;
  }): Promise<TurnResult> {
    const tmpDir = join(params.session.directory, ".puppenclaw", "tmp");
    await mkdir(tmpDir, { recursive: true });
    const outputPath = join(
      tmpDir,
      `${params.session.name.replace(/[^A-Za-z0-9._-]+/gu, "_")}-${Date.now()}-last-message.txt`
    );
    const providerLauncher = this.deps.config.agentCommands.codex?.trim() ?? "codex";
    const providerLauncherParts = splitCommandLine(providerLauncher);
    const codexArgs = [
      "exec",
      "--cd",
      params.session.directory,
      "--skip-git-repo-check",
      ...buildCodexPermissionArgs(params.permissionMode),
      "--json",
      "--output-last-message",
      outputPath,
      ...(params.session.model != null ? ["-m", params.session.model] : []),
      ...(params.session.runtimeEffort != null
        ? ["-c", `model_reasoning_effort="${params.session.runtimeEffort}"`]
        : []),
      "-"
    ];
    const codexCommand = this.deps.config.codexCommand?.trim();
    const directCommandArgs =
      codexCommand != null
        ? ["--cwd", params.session.directory, "--", ...providerLauncherParts, ...codexArgs]
        : codexArgs;
    const spawnCommand = resolveSpawnCommand(codexCommand ?? providerLauncher, directCommandArgs);
    const runtimeEnv = this.modelProviderRuntimeEnv(params.session.modelProvider);
    const env = {
      ...process.env,
      ...(runtimeEnv ?? {}),
      // Derived only from Puppenclaw's validated turn controls. The Codex
      // wrapper converts this out-of-band value into trusted model
      // instructions, so user prompt text cannot elevate a planning turn.
      PUPPENCLAW_CODEX_TURN_POLICY: deriveCodexTurnPolicy(
        params.interactionMode,
        params.permissionMode
      ),
      PUPPENCLAW_DIRECT_CODEX_AGENT_COMMAND:
        process.env.PUPPENCLAW_DIRECT_CODEX_AGENT_COMMAND ?? process.env.CODEX_EXECUTABLE ?? "codex"
    };

    this.startActiveTurnOutput(params.session.name);
    const child = spawnCommand.shell
      ? spawn(spawnCommand.command, {
          cwd: params.session.directory,
          stdio: ["pipe", "pipe", "pipe"],
          shell: true,
          detached: process.platform !== "win32",
          env
        })
      : spawn(spawnCommand.command, spawnCommand.args, {
          cwd: params.session.directory,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          env
        });
    this.registerActiveTurnProcess(params.session.name, child);

    let stderr = "";
    let pendingStdout = "";
    const liveOutputChunks: string[] = [];
    const dispatchTasks: Array<Promise<void>> = [];
    let latestCodexUsage: NormalizedUsage | undefined;
    const appendLiveOutput = (text: string): void => {
      const sanitized = sanitizeActiveTurnText(text);
      if (sanitized.length === 0) {
        return;
      }
      liveOutputChunks.push(sanitized);
      this.appendActiveTurnOutput(params.session.name, sanitized);
      dispatchTasks.push(this.deps.outputRouter.onChunk(params.session.name, sanitized));
    };
    const consumeStdoutLine = (line: string): void => {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isRecord(parsed)) {
          return;
        }
        const activity = extractCodexActivity(parsed);
        if (activity != null) {
          dispatchTasks.push(this.deps.outputRouter.onActivity(params.session.name, activity));
        }
        const visibleText = extractCodexLiveOutput(parsed);
        if (visibleText != null && visibleText.length > 0) {
          appendLiveOutput(visibleText);
        }
        // Codex exec --json emits per-turn usage on `turn.completed.usage` and
        // cumulative usage under `token_count.info.total_token_usage`. Capture
        // it (last-writer-wins → final turn total) so the one-shot runtime
        // records real tokens instead of nothing.
        const codexEventType = asTrimmedString(parsed.type).toLowerCase();
        let codexUsageRaw: unknown;
        if (codexEventType === "turn.completed") {
          codexUsageRaw = parsed.usage;
        } else if (codexEventType === "token_count" && isRecord(parsed.info)) {
          codexUsageRaw = parsed.info.total_token_usage;
        }
        if (isRecord(codexUsageRaw)) {
          const usage = normalizeCodexUsage(codexUsageRaw);
          if (hasNonzeroUsage(usage)) {
            latestCodexUsage = usage;
          }
        }
      } catch {
        // `codex exec --json` stdout is a protocol channel. Never turn an
        // unparsable record into assistant prose: it may contain raw tool
        // arguments, tool output, or credentials from a broken relay.
        this.deps.logger.debug(
          `Ignored malformed Codex JSON event for session ${params.session.name}.`
        );
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pendingStdout += chunk;
      while (true) {
        const newlineIndex = pendingStdout.indexOf("\n");
        if (newlineIndex < 0) {
          break;
        }
        const line = pendingStdout.slice(0, newlineIndex).trim();
        pendingStdout = pendingStdout.slice(newlineIndex + 1);
        if (line.length > 0) {
          consumeStdoutLine(line);
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    // See runTurn: an early child exit must not turn the prompt write EPIPE
    // into an uncaught exception.
    child.stdin.on("error", (error: Error) => {
      this.deps.logger.debug(
        `Puppenclaw prompt stdin error for ${params.session.name}: ${error.message}`
      );
    });
    child.stdin.setDefaultEncoding("utf8");
    child.stdin.write(buildCodexPermissionPrompt(params.promptText, params.permissionMode));
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    }).catch((error) => {
      this.setActiveTurnOutput(params.session.name, `\n[error] ${ensureError(error).message}\n`);
      this.completeActiveTurnOutput(params.session.name);
      throw new PuppenclawError("CODEX_TURN_FAILED", ensureError(error).message);
    });

    const trailingStdoutLine = pendingStdout.trim();
    if (trailingStdoutLine.length > 0) {
      consumeStdoutLine(trailingStdoutLine);
    }
    await Promise.all(dispatchTasks);

    const finalOutput = (await readFile(outputPath, "utf8").catch(() => "")).trim();
    await unlink(outputPath).catch(() => {});
    const liveOutput = liveOutputChunks.join("").trim();
    const canonicalFinalOutput = sanitizeActiveTurnText(finalOutput);
    const combinedOutput = canonicalFinalOutput || liveOutput;

    if ((exitCode ?? 0) !== 0) {
      const message = sanitizeActiveTurnText(
        stderr.trim() || combinedOutput || `codex exited with code ${exitCode ?? "unknown"}`
      );
      this.deps.logger.warn(
        `Codex session ${params.session.name} exited with code ${exitCode ?? "unknown"}: ${message}`
      );
      const failureOutput = [liveOutput, `\n[error] ${message}\n`]
        .filter((part) => part.trim().length > 0)
        .join("\n");
      this.setActiveTurnOutput(params.session.name, failureOutput);
      await this.deps.outputRouter.onError(params.session.name, new Error(message));
      this.completeActiveTurnOutput(params.session.name);
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

    if (combinedOutput.length > 0) {
      const activeText = this.activeTurnOutputs.get(params.session.name)?.text ?? "";
      if (activeText.trim().length === 0) {
        this.appendActiveTurnOutput(params.session.name, combinedOutput);
        await this.deps.outputRouter.onChunk(params.session.name, combinedOutput);
      } else if (
        canonicalFinalOutput.length > 0 &&
        !activeText.includes(
          canonicalFinalOutput.slice(0, Math.min(canonicalFinalOutput.length, 240))
        )
      ) {
        const finalChunk = `\n\n${canonicalFinalOutput}`;
        this.appendActiveTurnOutput(params.session.name, finalChunk);
        await this.deps.outputRouter.onChunk(params.session.name, finalChunk);
      }
    }
    const result = await this.finishSuccessfulTurn({
      sessionName: params.session.name,
      output: combinedOutput,
      ...(latestCodexUsage != null ? { usage: latestCodexUsage } : {})
    });
    this.completeActiveTurnOutput(params.session.name);
    return result;
  }

  private startActiveTurnOutput(sessionName: string): void {
    const now = nowIso();
    this.activeTurnOutputs.set(sessionName, {
      sessionName,
      text: "",
      startedAt: now,
      updatedAt: now,
      complete: false
    });
  }

  private appendActiveTurnOutput(sessionName: string, text: string): void {
    const current = this.activeTurnOutputs.get(sessionName);
    if (current == null) {
      return;
    }
    const nextText = `${current.text}${text}`;
    const boundedText =
      nextText.length <= MAX_ACTIVE_TURN_OUTPUT_CHARS
        ? nextText
        : `[active output truncated: kept latest ${MAX_ACTIVE_TURN_OUTPUT_CHARS} chars]\n${nextText.slice(
            -MAX_ACTIVE_TURN_OUTPUT_CHARS
          )}`;
    this.activeTurnOutputs.set(sessionName, {
      ...current,
      text: boundedText,
      updatedAt: nowIso()
    });
  }

  private setActiveTurnOutput(sessionName: string, text: string): void {
    const current = this.activeTurnOutputs.get(sessionName);
    if (current == null) {
      return;
    }
    const sanitized = sanitizeActiveTurnText(text);
    const boundedText =
      sanitized.length <= MAX_ACTIVE_TURN_OUTPUT_CHARS
        ? sanitized
        : `[active output truncated: kept latest ${MAX_ACTIVE_TURN_OUTPUT_CHARS} chars]\n${sanitized.slice(
            -MAX_ACTIVE_TURN_OUTPUT_CHARS
          )}`;
    this.activeTurnOutputs.set(sessionName, {
      ...current,
      text: boundedText,
      updatedAt: nowIso()
    });
  }

  private completeActiveTurnOutput(sessionName: string): void {
    const current = this.activeTurnOutputs.get(sessionName);
    if (current == null) {
      return;
    }
    this.activeTurnOutputs.set(sessionName, {
      ...current,
      updatedAt: nowIso(),
      complete: true
    });
  }

  private registerActiveTurnProcess(sessionName: string, child: ChildProcess): void {
    this.activeTurnProcesses.set(sessionName, {
      child
    });
    const clear = (): void => {
      if (this.activeTurnProcesses.get(sessionName)?.child === child) {
        this.activeTurnProcesses.delete(sessionName);
      }
    };
    child.once("close", clear);
    child.once("error", clear);
  }

  /**
   * Signals the whole process TREE of the currently-registered turn process:
   * `taskkill /pid <pid> /T /F` on win32 (a plain child.kill would only hit
   * the cmd.exe shell wrapper and orphan the real agent process) and a
   * process-group kill on POSIX (the spawns set `detached: true`).
   *
   * When `expectedChild` is provided the kill is identity-guarded: it becomes
   * a no-op if the registered turn process is no longer that same child, so a
   * delayed escalation can never kill a newer turn's process.
   */
  private terminateActiveTurnProcess(
    sessionName: string,
    signal: NodeJS.Signals,
    expectedChild?: ChildProcess
  ): ChildProcess | null {
    const active = this.activeTurnProcesses.get(sessionName);
    if (active == null) {
      return null;
    }
    if (expectedChild != null && active.child !== expectedChild) {
      return null;
    }
    killProcessTree(active.child, signal, (error) => {
      this.deps.logger.warn(`Failed to signal active turn for ${sessionName}: ${error.message}`);
    });
    return active.child;
  }

  private async finishSuccessfulTurn(params: {
    sessionName: string;
    output: string;
    signals?: TurnSignals;
    tokenUsage?: TokenUsage;
    usage?: NormalizedUsage;
    stopReason?: string;
    durationMs?: number;
  }): Promise<TurnResult> {
    const signals = mergeTurnSignals(
      params.signals,
      params.stopReason != null ? { stopReason: params.stopReason } : undefined
    );
    const question =
      signals?.inputRequest?.text ??
      (signals?.inputRequest != null
        ? "Agent requested user input."
        : signals?.plan == null
          ? resolveQuestionFromOutput(params.output)
          : undefined);
    await this.deps.outputRouter.onFinal(params.sessionName, params.output);
    if (question != null) {
      await this.deps.outputRouter.onQuestion(params.sessionName, question);
    }
    await this.deps.outputRouter.onComplete(
      params.sessionName,
      question != null ? "Turn completed and is waiting for user input." : "Turn completed."
    );

    return {
      output: params.output,
      ...(question != null ? { question } : {}),
      ...(params.tokenUsage != null ? { tokenUsage: params.tokenUsage } : {}),
      ...(params.usage != null ? { usage: params.usage } : {}),
      ...(params.stopReason != null ? { stopReason: params.stopReason } : {}),
      ...(params.durationMs != null ? { durationMs: params.durationMs } : {}),
      ...(signals != null ? { signals } : {}),
      warnings: [],
      transcript: makeAssistantTranscript(params.output),
      state: question != null ? "waiting_input" : "idle"
    };
  }

  private async runControlCommand(params: {
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    allowNoSession?: boolean;
    timeoutMs?: number;
  }): Promise<ControlCommandResult> {
    return await new Promise<ControlCommandResult>((resolve, reject) => {
      const spawnCommand = resolveSpawnCommand(this.deps.config.acpxCommand ?? "acpx", params.args);
      const child = spawnCommand.shell
        ? spawn(spawnCommand.command, {
            cwd: params.cwd,
            stdio: ["ignore", "pipe", "pipe"],
            shell: true,
            detached: process.platform !== "win32",
            env: params.env != null ? { ...process.env, ...params.env } : process.env
          })
        : spawn(spawnCommand.command, spawnCommand.args, {
            cwd: params.cwd,
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
            env: params.env != null ? { ...process.env, ...params.env } : process.env
          });
      let settled = false;
      const timeout =
        params.timeoutMs == null
          ? null
          : setTimeout(() => {
              if (settled) {
                return;
              }
              settled = true;
              killProcessTreeWithEscalation(child, 250, (error) => {
                this.deps.logger.warn(
                  `Failed to stop timed-out ACP control command: ${error.message}`
                );
              });
              reject(
                new PuppenclawError(
                  "ACP_CONTROL_TIMEOUT",
                  `ACPX control command timed out after ${params.timeoutMs}ms.`
                )
              );
            }, params.timeoutMs);
      timeout?.unref();
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
        if (settled) {
          return;
        }
        settled = true;
        if (timeout != null) {
          clearTimeout(timeout);
        }
        reject(
          new PuppenclawError(
            "ACP_CONTROL_FAILED",
            `Failed running acpx command: ${ensureError(error).message}`
          )
        );
      });
      child.once("close", (exitCode: number | null) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout != null) {
          clearTimeout(timeout);
        }
        const events = parseJsonLines(stdout);
        const errorEvent = events.map((event) => toErrorRecord(event)).find(Boolean) ?? null;
        if (errorEvent != null && !(params.allowNoSession && errorEvent.code === "NO_SESSION")) {
          reject(new PuppenclawError(errorEvent.code ?? "ACP_CONTROL_FAILED", errorEvent.message));
          return;
        }
        if (
          (exitCode ?? 0) !== 0 &&
          !(params.allowNoSession && errorEvent?.code === "NO_SESSION")
        ) {
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
