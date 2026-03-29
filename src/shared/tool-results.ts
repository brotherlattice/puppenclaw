import type { ToolResult } from "./types.js";

export function textToolResult<TDetails = Record<string, unknown>>(
  text: string,
  details?: TDetails
): ToolResult<TDetails> {
  return {
    content: [{ type: "text", text }],
    details: (details ?? ({} as TDetails))
  };
}

export function jsonToolResult<TPayload>(payload: TPayload, label?: string): ToolResult<TPayload> {
  const prefix = label?.trim();
  const text = prefix ? `${prefix}\n${JSON.stringify(payload, null, 2)}` : JSON.stringify(payload, null, 2);
  return textToolResult(text, payload);
}
