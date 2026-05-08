import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { SessionStore } from "../shared/store.js";
import type { ReassessmentProvider, SessionTranscriptEntry } from "../shared/types.js";
import { collectJsonLines, pathExists, truncateText } from "../shared/utils.js";
import type { ImportedReassessmentSession, ProjectRecord } from "./types.js";

const MAX_EXTERNAL_FILES = 200;
const MAX_TRANSCRIPT_CHARS = 12_000;

export type ReassessmentImportResult = {
  sessions: ImportedReassessmentSession[];
  warnings: string[];
};

type ImportParams = {
  project: ProjectRecord;
  providers: ReassessmentProvider[];
  limit: number;
  sessionStore: SessionStore;
};

type SessionCandidate = {
  provider: ReassessmentProvider;
  title: string;
  sourcePath?: string;
  projectRoot?: string;
  detectedModel?: string;
  createdAt?: string;
  updatedAt?: string;
  transcript: SessionTranscriptEntry[];
};

export async function importReassessmentSessions(params: ImportParams): Promise<ReassessmentImportResult> {
  const warnings: string[] = [];
  const candidates: SessionCandidate[] = [];
  for (const provider of params.providers) {
    if (provider === "puppenclaw") {
      candidates.push(...importPuppenclawSessions(params.project, params.sessionStore));
    } else if (provider === "claude") {
      const imported = await importClaudeSessions(params.project);
      candidates.push(...imported.sessions);
      warnings.push(...imported.warnings);
    } else if (provider === "codex") {
      const imported = await importCodexSessions(params.project);
      candidates.push(...imported.sessions);
      warnings.push(...imported.warnings);
    }
  }
  const sessions = candidates
    .map(normalizeCandidate)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, params.limit);
  return { sessions, warnings };
}

function importPuppenclawSessions(
  project: ProjectRecord,
  sessionStore: SessionStore
): SessionCandidate[] {
  return sessionStore
    .listSessions()
    .filter((session) => pathWithinProject(session.directory, project.rootDir))
    .filter((session) => session.transcript.length > 0)
    .filter((session) => !isReassessmentTranscript(session.transcript))
    .map((session) => ({
      provider: "puppenclaw" as const,
      title: session.name,
      projectRoot: session.directory,
      createdAt: session.createdAt,
      updatedAt: session.lastActivity,
      transcript: session.transcript,
      ...(session.model != null ? { detectedModel: session.model } : {})
    }));
}

async function importClaudeSessions(project: ProjectRecord): Promise<{
  sessions: SessionCandidate[];
  warnings: string[];
}> {
  const root = join(resolveHomeDir(), ".claude", "projects");
  if (!(await pathExists(root))) {
    return { sessions: [], warnings: [`Claude Code history root not found: ${root}`] };
  }
  const files = await collectFiles(root, (path) => path.endsWith(".jsonl"), MAX_EXTERNAL_FILES);
  const sessions: SessionCandidate[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    const entries = await collectJsonLines(file);
    const transcript = entries
      .map((entry) => claudeEntryToTranscript(entry))
      .filter((entry): entry is SessionTranscriptEntry => entry != null);
    if (transcript.length === 0) {
      continue;
    }
    if (isReassessmentTranscript(transcript)) {
      continue;
    }
    const cwd = firstString(entries, "cwd");
    if (!pathWithinProject(cwd, project.rootDir) && !encodedPathMatches(file, project.rootDir)) {
      continue;
    }
    const updatedAt = latestTimestamp(entries) ?? transcript.at(-1)?.createdAt;
    sessions.push({
      provider: "claude",
      title: `claude:${basename(file, ".jsonl")}`,
      sourcePath: file,
      ...(cwd != null ? { projectRoot: cwd } : {}),
      ...(transcript[0]?.createdAt != null ? { createdAt: transcript[0].createdAt } : {}),
      ...(updatedAt != null ? { updatedAt } : {}),
      transcript
    });
  }
  if (files.length >= MAX_EXTERNAL_FILES) {
    warnings.push(`Claude Code import stopped after ${MAX_EXTERNAL_FILES} JSONL files.`);
  }
  return { sessions, warnings };
}

async function importCodexSessions(project: ProjectRecord): Promise<{
  sessions: SessionCandidate[];
  warnings: string[];
}> {
  const codexRoot = join(resolveHomeDir(), ".codex");
  const historyPath = join(codexRoot, "history.jsonl");
  const indexPath = join(codexRoot, "session_index.jsonl");
  if (!(await pathExists(historyPath))) {
    return { sessions: [], warnings: [`Codex history file not found: ${historyPath}`] };
  }
  const history = await collectJsonLines(historyPath);
  const index = await (await pathExists(indexPath) ? collectJsonLines(indexPath) : Promise.resolve([]));
  const names = new Map<string, string>();
  const updated = new Map<string, string>();
  for (const entry of index) {
    const id = stringValue(entry.id);
    if (id == null) {
      continue;
    }
    const title = stringValue(entry.thread_name);
    if (title != null) {
      names.set(id, title);
    }
    const updatedAt = stringValue(entry.updated_at);
    if (updatedAt != null) {
      updated.set(id, updatedAt);
    }
  }
  const grouped = new Map<string, SessionTranscriptEntry[]>();
  for (const entry of history) {
    const sessionId = stringValue(entry.session_id);
    const text = stringValue(entry.text);
    if (sessionId == null || text == null) {
      continue;
    }
    const current = grouped.get(sessionId) ?? [];
    current.push({
      role: "user",
      text,
      createdAt: stringValue(entry.ts) ?? new Date(0).toISOString()
    });
    grouped.set(sessionId, current);
  }
  const matchText = `${project.rootDir}\n${project.name}\n${project.id}`.toLowerCase();
  const sessions: SessionCandidate[] = [];
  for (const [sessionId, transcript] of grouped) {
    const combined = transcript.map((entry) => entry.text).join("\n").toLowerCase();
    if (isReassessmentTranscript(transcript)) {
      continue;
    }
    const title = names.get(sessionId) ?? `codex:${sessionId}`;
    if (!combined.includes(project.rootDir.toLowerCase()) && !combined.includes(project.name.toLowerCase()) && !matchText.includes(title.toLowerCase())) {
      continue;
    }
    const updatedAt = updated.get(sessionId) ?? transcript.at(-1)?.createdAt;
    sessions.push({
      provider: "codex",
      title,
      sourcePath: historyPath,
      transcript,
      ...(updatedAt != null ? { updatedAt } : {}),
      ...(transcript[0]?.createdAt != null ? { createdAt: transcript[0].createdAt } : {})
    });
  }
  return {
    sessions,
    warnings: [
      "Codex JSONL history does not reliably expose cwd; only sessions with project-identifying text were imported."
    ]
  };
}

async function collectFiles(
  root: string,
  predicate: (path: string) => boolean,
  limit: number
): Promise<string[]> {
  const files: string[] = [];
  async function walk(path: string): Promise<void> {
    if (files.length >= limit) {
      return;
    }
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= limit) {
        return;
      }
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile() && predicate(child)) {
        const info = await stat(child).catch(() => null);
        if (info != null && info.size <= 5 * 1024 * 1024) {
          files.push(child);
        }
      }
    }
  }
  await walk(root);
  return files;
}

function normalizeCandidate(candidate: SessionCandidate): ImportedReassessmentSession {
  const transcriptText = transcriptToText(candidate.transcript);
  const { text } = truncateText(transcriptText, MAX_TRANSCRIPT_CHARS);
  const hash = createHash("sha256")
    .update(`${candidate.provider}\n${candidate.sourcePath ?? candidate.title}\n${transcriptText}`)
    .digest("hex");
  return {
    id: `${candidate.provider}:${hash.slice(0, 16)}`,
    provider: candidate.provider,
    title: candidate.title,
    ...(candidate.sourcePath != null ? { sourcePath: candidate.sourcePath } : {}),
    ...(candidate.projectRoot != null ? { projectRoot: candidate.projectRoot } : {}),
    ...(candidate.detectedModel != null ? { detectedModel: candidate.detectedModel } : {}),
    ...(candidate.createdAt != null ? { createdAt: candidate.createdAt } : {}),
    updatedAt: candidate.updatedAt ?? candidate.createdAt ?? new Date(0).toISOString(),
    transcriptHash: hash,
    transcriptChars: transcriptText.length,
    transcriptPreview: text
  };
}

function transcriptToText(transcript: SessionTranscriptEntry[]): string {
  return transcript
    .map((entry) => `[${entry.createdAt}] ${entry.role}: ${entry.text}`)
    .join("\n\n")
    .trim();
}

function isReassessmentTranscript(transcript: SessionTranscriptEntry[]): boolean {
  return transcript.some((entry) => entry.text.includes("PUPPENCLAW_REASSESSMENT"));
}

function claudeEntryToTranscript(entry: Record<string, unknown>): SessionTranscriptEntry | null {
  const type = stringValue(entry.type);
  const role = type === "assistant" ? "assistant" : type === "user" ? "user" : null;
  const text = extractText(entry.message) ?? extractText(entry.content);
  if (role == null || text == null || text.trim().length === 0) {
    return null;
  }
  return {
    role,
    text,
    createdAt: stringValue(entry.timestamp) ?? new Date(0).toISOString()
  };
}

function extractText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const joined = value.map((entry) => extractText(entry)).filter(Boolean).join("\n");
    return joined.length > 0 ? joined : null;
  }
  if (value != null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return extractText(record.content) ?? stringValue(record.text) ?? null;
  }
  return null;
}

function firstString(entries: Record<string, unknown>[], key: string): string | undefined {
  for (const entry of entries) {
    const value = stringValue(entry[key]);
    if (value != null && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function latestTimestamp(entries: Record<string, unknown>[]): string | undefined {
  return entries
    .map((entry) => stringValue(entry.timestamp) ?? stringValue(entry.updated_at) ?? stringValue(entry.ts))
    .filter((value): value is string => value != null)
    .sort()
    .at(-1);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function resolveHomeDir(): string {
  return process.env.HOME ?? homedir();
}

function pathWithinProject(path: string | null | undefined, projectRoot: string): boolean {
  if (path == null || path.trim().length === 0) {
    return false;
  }
  const normalizedPath = normalizePath(path);
  const normalizedProject = normalizePath(projectRoot);
  return normalizedPath === normalizedProject || normalizedPath.startsWith(`${normalizedProject}/`);
}

function encodedPathMatches(path: string, projectRoot: string): boolean {
  const normalizedPath = path.toLowerCase();
  const encodedProject = normalizePath(projectRoot).replace(/\//gu, "-");
  return normalizedPath.includes(encodedProject);
}

function normalizePath(path: string): string {
  return resolve(path).replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
}
