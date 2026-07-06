import type { NormalizedUsage } from "./types.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readUsageNumber(source: JsonRecord, keys: readonly string[]): number {
  for (const key of keys) {
    const value = asFiniteNumber(source[key]);
    if (value != null) {
      return value;
    }
  }
  return 0;
}

/**
 * Normalize a provider `usage` payload into the canonical four-bucket shape,
 * accepting the superset of field-name variants that ACP adapters (Claude /
 * Codex) and their underlying providers emit. Mirrors OpenClaw core's
 * `UsageLike` → `NormalizedUsage`. `total` is always the sum of the four
 * buckets (an explicit provider total is ignored — it usually excludes cache).
 */
export function normalizeUsage(raw: unknown): NormalizedUsage {
  const record = isRecord(raw) ? raw : {};
  const source: JsonRecord = isRecord(record.usage)
    ? { ...record, ...(record.usage as JsonRecord) }
    : record;
  const input = readUsageNumber(source, [
    "input",
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens"
  ]);
  const output = readUsageNumber(source, [
    "output",
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens"
  ]);
  let cacheRead = readUsageNumber(source, [
    "cacheRead",
    "cache_read",
    "cacheReadInputTokens",
    "cache_read_input_tokens",
    "cachedTokens",
    "cached_tokens"
  ]);
  if (cacheRead === 0 && isRecord(source.prompt_tokens_details)) {
    cacheRead = asFiniteNumber((source.prompt_tokens_details as JsonRecord).cached_tokens) ?? 0;
  }
  const cacheWrite = readUsageNumber(source, [
    "cacheWrite",
    "cache_write",
    "cacheCreationInputTokens",
    "cache_creation_input_tokens"
  ]);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite
  };
}

export function hasNonzeroUsage(usage: NormalizedUsage): boolean {
  return usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0;
}
