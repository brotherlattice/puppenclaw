import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";

import { ensureError } from "./errors.js";
import type { ContextFileEntry, PromptEvent } from "./types.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    const err = ensureError(error);
    if ("code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw err;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolvePathMaybe(basePath: string, input: string): string {
  return isAbsolute(input) ? input : resolve(basePath, input);
}

export function truncateText(input: string, maxChars: number): { text: string; truncated: boolean } {
  if (input.length <= maxChars) {
    return { text: input, truncated: false };
  }
  return {
    text: `${input.slice(0, maxChars)}\n\n[truncated]`,
    truncated: true
  };
}

export async function loadContextFiles(
  cwd: string,
  paths: readonly string[],
  limits: { maxFiles?: number; maxBytesPerFile?: number } = {}
): Promise<{
  promptText: string;
  files: ContextFileEntry[];
}> {
  const maxFiles = limits.maxFiles ?? 6;
  const maxBytesPerFile = limits.maxBytesPerFile ?? 32 * 1024;
  const files: ContextFileEntry[] = [];
  const blocks: string[] = [];

  for (const path of paths.slice(0, maxFiles)) {
    const resolvedPath = resolvePathMaybe(cwd, path);
    const fileStat = await stat(resolvedPath);
    const raw = await readFile(resolvedPath, "utf8");
    const { text, truncated } = truncateText(raw, maxBytesPerFile);
    files.push({
      path,
      resolvedPath,
      bytes: fileStat.size,
      truncated
    });
    blocks.push(`FILE: ${path}\n${text}`);
  }

  return {
    promptText: blocks.length > 0 ? `Context files follow.\n\n${blocks.join("\n\n---\n\n")}` : "",
    files
  };
}

export async function collectJsonLines(path: string): Promise<Record<string, unknown>[]> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream });
  const entries: Record<string, unknown>[] = [];
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          entries.push(parsed as Record<string, unknown>);
        }
      } catch {
        // ignore malformed lines in tests/utilities
      }
    }
  } finally {
    lines.close();
  }
  return entries;
}

export function summarizePromptEvents(events: readonly PromptEvent[]): string {
  const chunks = events
    .filter((event): event is Extract<PromptEvent, { type: "text_delta" }> => event.type === "text_delta")
    .filter((event) => event.stream === "output")
    .map((event) => event.text);
  return chunks.join("");
}
