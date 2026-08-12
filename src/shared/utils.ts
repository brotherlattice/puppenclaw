import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import { ensureError } from "./errors.js";
import type { ContextFileEntry, PromptEvent } from "./types.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function writeJsonFileAtomic(
  path: string,
  value: unknown,
  options: { mode?: number } = {}
): Promise<void> {
  await ensureDir(dirname(path));
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tmpPath, "w", options.mode);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, path);
  if (options.mode != null) {
    await chmod(path, options.mode).catch(() => {});
  }
  try {
    const dirHandle = await open(dirname(path), "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Directory fsync is unsupported on some platforms (notably Windows);
    // the rename above is still atomic, so degrade silently.
  }
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

/**
 * Best-effort quarantine: renames `path` to `<path>.corrupt-<timestamp>` so a
 * damaged or outdated file is preserved for inspection instead of being
 * overwritten. Returns the quarantine path, or null when the rename failed.
 */
export async function quarantineFile(path: string): Promise<string | null> {
  const quarantinePath = `${path}.corrupt-${nowIso().replaceAll(":", "-")}`;
  try {
    await rename(path, quarantinePath);
    return quarantinePath;
  } catch (error) {
    console.error(
      `Failed to quarantine ${path}: ${ensureError(error).message}`
    );
    return null;
  }
}

/**
 * Like readJsonFile, but a file with unparseable JSON (e.g. truncated by a
 * host crash) is quarantined and replaced by the fallback instead of throwing.
 */
export async function readJsonFileResilient<T>(path: string, fallback: T): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const err = ensureError(error);
    if ("code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const quarantinePath = await quarantineFile(path);
    console.error(
      quarantinePath != null
        ? `Corrupt JSON in ${path} (${ensureError(error).message}); quarantined to ${quarantinePath} and continuing with fresh state.`
        : `Corrupt JSON in ${path} (${ensureError(error).message}); quarantine failed, continuing with fresh state.`
    );
    return fallback;
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

/**
 * Resolves `candidate` against `root` and returns the absolute path only if it
 * stays inside `root`. Returns null when the candidate escapes the root:
 * - any `..` path segment (either separator style) is rejected outright,
 * - absolute candidates outside the root are rejected,
 * - the containment check is boundary-aware ("/a/proj" does NOT contain
 *   "/a/proj-evil") and case-insensitive on win32.
 */
export function confineToRoot(root: string, candidate: string): string | null {
  const hasParentTraversal = candidate
    .split(/[\\/]+/u)
    .some((segment) => segment === "..");
  if (hasParentTraversal) {
    return null;
  }
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(resolvedRoot, candidate);
  const caseFold = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const rootCompare = caseFold(resolvedRoot);
  const candidateCompare = caseFold(resolvedCandidate);
  if (candidateCompare === rootCompare) {
    return resolvedCandidate;
  }
  const rootWithSep = rootCompare.endsWith(sep) ? rootCompare : `${rootCompare}${sep}`;
  return candidateCompare.startsWith(rootWithSep) ? resolvedCandidate : null;
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

/** Redact common durable-output secrets while leaving ordinary URLs untouched. */
export function redactSensitiveText(text: string): string {
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
    )
    .replace(
      /(["']?[A-Z0-9_]{0,128}(?:API_KEY|TOKEN|SECRET|PASSWORD)["']?\s*[:=]\s*["']?)[^"',}\s]+/gu,
      "$1[redacted]"
    )
    .replace(
      /(\b(?:incorrect|invalid|provided|using)\s+(?:api\s+)?key(?:\s+provided)?\s*[:=]?\s*)\b(?:sk|pk|rk|key)-[A-Za-z0-9._-]+/giu,
      "$1[redacted]"
    )
    .replace(/\b(?:sk|pk|rk)-(?:proj-|ant-)?[A-Za-z0-9._-]{6,}\b/gu, "[redacted]")
    .replace(/\b(https?:\/\/)([^/\s@]+)@/giu, "$1[redacted]@")
    .replace(
      /([?&](?:access[_-]?token|api[_-]?key|auth(?:orization)?|password|secret|signature)=)[^&#\s"'<>]+/giu,
      "$1[redacted]"
    );
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
