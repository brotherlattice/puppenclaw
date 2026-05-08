#!/usr/bin/env node

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";

function jsonEscape(value = "") {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
}

function emitJson(value) {
  process.stdout.write(`${value}\n`);
}

function trimWhitespace(value) {
  return String(value).replace(/\s+/gu, " ").trim();
}

function splitText(text, size = 14) {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

let cwd = process.cwd();
let agent = "";
const args = process.argv.slice(2);
let index = 0;

while (index < args.length) {
  const current = args[index];
  if (current === "--cwd") {
    cwd = args[index + 1] ?? process.cwd();
    index += 2;
  } else if (current === "--format") {
    index += 2;
  } else if (
    current === "--json-strict" ||
    current === "--approve-reads" ||
    current === "--approve-all" ||
    current === "--deny-all"
  ) {
    index += 1;
  } else if (current === "--non-interactive-permissions") {
    index += 2;
  } else if (current === "--agent") {
    agent = args[index + 1] ?? "";
    index += 2;
  } else if (current.startsWith("--")) {
    break;
  } else {
    if (agent.length === 0) {
      agent = current;
      index += 1;
    }
    break;
  }
}

if (agent.length === 0) {
  agent = "unknown";
}

const command = args.slice(index);
const stateDir = join(cwd, ".fake-acpx-state");
mkdirSync(stateDir, { recursive: true });

function sessionFile(name) {
  return join(stateDir, `${basename(name)}.session`);
}

function readSession(name) {
  try {
    const [status = "alive", sessionAgent = agent] = readFileSync(sessionFile(name), "utf8").split(/\r?\n/u);
    return { status, agent: sessionAgent };
  } catch {
    return null;
  }
}

function writeSession(name, status, sessionAgent) {
  writeFileSync(sessionFile(name), `${status}\n${sessionAgent}\n`, "utf8");
}

function emitError(code, message) {
  emitJson(`{"type":"error","code":"${jsonEscape(code)}","message":"${jsonEscape(message)}"}`);
}

if (command[0] === "status" && command[1] === "--session" && command[2] != null) {
  const name = command[2];
  const session = readSession(name);
  if (session == null) {
    emitJson('{"action":"status_snapshot","status":"no-session","summary":"no active session"}');
    process.exit(0);
  }
  emitJson(
    `{"status":"${jsonEscape(session.status)}","acpxRecordId":"rec-${jsonEscape(
      name
    )}","acpxSessionId":"backend-${jsonEscape(name)}","agentSessionId":"agent-${jsonEscape(
      name
    )}","agent":"${jsonEscape(agent || session.agent)}"}`
  );
  process.exit(0);
}

if (command[0] === "sessions" && command[1] === "new") {
  let name = `session-${Date.now()}`;
  for (let commandIndex = 0; commandIndex < command.length; commandIndex += 1) {
    if (command[commandIndex] === "--name" && command[commandIndex + 1] != null) {
      name = command[commandIndex + 1];
      break;
    }
  }
  writeSession(name, "alive", agent);
  emitJson(
    `{"acpxRecordId":"rec-${jsonEscape(name)}","acpxSessionId":"backend-${jsonEscape(
      name
    )}","agentSessionId":"agent-${jsonEscape(name)}","status":"alive"}`
  );
  process.exit(0);
}

if (command[0] === "sessions" && command[1] === "close" && command[2] != null) {
  rmSync(sessionFile(command[2]), { force: true });
  emitJson('{"status":"closed"}');
  process.exit(0);
}

if (command[0] === "cancel" && command[1] === "--session" && command[2] != null) {
  const name = command[2];
  const session = readSession(name);
  if (session != null) {
    writeSession(name, "alive", session.agent);
  }
  emitJson('{"status":"cancelled"}');
  process.exit(0);
}

if (command[0] === "prompt" && command[1] === "--session" && command[2] != null) {
  const name = command[2];
  const input = readFileSync(0, "utf8");
  const normalizedInput = trimWhitespace(input);
  if (readSession(name) == null) {
    emitJson(
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32002,"message":"No acpx session found","data":{"acpxCode":"NO_SESSION","origin":"cli","sessionId":"unknown"}}}'
    );
    process.exit(4);
  }
  emitJson(`{"type":"usage_update","used":${normalizedInput.length},"size":4096}`);
  let reply;
  if (normalizedInput.includes("FAIL_TURN")) {
    emitError("SIM_FAIL", "Simulated turn failure");
    process.exit(0);
  } else if (normalizedInput.includes("PUPPENFUSION_ROLE: planning")) {
    if (normalizedInput.includes("PUPPENFUSION_CANDIDATE: codex")) {
      reply =
        "## Scope\nImplement the requested feature with minimal risk.\n## Architecture\nPrefer a direct module change.\n## Files\n- src.ts\n- codex-plan.txt\n## Validation\n- Run the configured evaluation command.\n## Risks\n- Keep scope bounded to the sealed bundle.";
    } else {
      reply =
        "## Scope\nImplement the requested feature cleanly from the sealed bundle.\n## Architecture\nFavor explicit structure and readable changes.\n## Files\n- src.ts\n- claude-plan.txt\n## Validation\n- Run the configured evaluation command.\n## Risks\n- Avoid widening scope beyond the approved plan.";
    }
  } else if (normalizedInput.includes("PUPPENFUSION_ROLE: implementation")) {
    if (normalizedInput.includes("PUPPENFUSION_CANDIDATE: codex")) {
      writeFileSync(join(cwd, "codex-candidate.txt"), "codex candidate output\n", "utf8");
      reply =
        "## Summary\nImplemented the Codex candidate.\n## Changed Areas\n- Added codex-candidate.txt\n## Decisions\n- Keep the change isolated to Codex-owned output.\n## Risks\n- Minimal.\n## Validation\n- Ready for evaluation.";
    } else {
      writeFileSync(join(cwd, "claude-candidate.txt"), "claude candidate output\n", "utf8");
      reply =
        "## Summary\nImplemented the Claude candidate.\n## Changed Areas\n- Added claude-candidate.txt\n## Decisions\n- Keep the change isolated to Claude-owned output.\n## Risks\n- Minimal.\n## Validation\n- Ready for evaluation.";
    }
  } else if (normalizedInput.includes("PUPPENFUSION_ROLE: peer_review")) {
    if (normalizedInput.includes("PUPPENFUSION_CANDIDATE: codex")) {
      reply =
        "## Verdict\nAccept with small follow-up.\n## Strengths\n- The Claude candidate is readable.\n## Weaknesses\n- The change could expose more rationale.\n## Risks\n- Low.\n## Merge Guidance\n- Keep the file-level change and preserve the bounded scope.";
    } else {
      reply =
        "## Verdict\nAccept with small follow-up.\n## Strengths\n- The Codex candidate is direct.\n## Weaknesses\n- The change could expose more rationale.\n## Risks\n- Low.\n## Merge Guidance\n- Keep the file-level change and preserve the bounded scope.";
    }
  } else if (normalizedInput.includes("PUPPENFUSION_ROLE: merge")) {
    writeFileSync(join(cwd, "merged-candidate.txt"), "resolved merged output\n", "utf8");
    reply =
      "## Summary\nResolved the fusion merge in the merged worktree.\n## Incorporated from Codex\n- Preserved the direct candidate change.\n## Incorporated from Claude\n- Preserved the readable candidate change.\n## Remaining Risks\n- Low.\n## Validation\n- Ready for evaluation.";
  } else if (normalizedInput.includes("PUPPENCLAW_REASSESSMENT")) {
    writeFileSync(join(cwd, "reassessment-fix.txt"), "conservative reassessment fix\n", "utf8");
    reply =
      "## Executive judgment\nPatched one obvious old-model mistake.\n## Imported sessions reviewed\n- Reviewed imported fixtures.\n## Findings by importance\n- functionality: missing reassessment-fix.txt was an obvious prior omission.\n## Patches made\n- Added reassessment-fix.txt.\n## Findings intentionally not patched\n- No refactor-only findings patched.\n## Validation instructions and residual risk\n- Run the configured validation command.";
  } else if (normalizedInput.includes("ASK_USER")) {
    reply = "Need input from the user?";
  } else {
    reply = `Handled: ${normalizedInput}`;
  }
  for (const chunk of splitText(reply, 14)) {
    emitJson(
      `{"type":"agent_message_chunk","content":{"type":"text","text":"${jsonEscape(chunk)}"}}`
    );
  }
  emitJson('{"type":"done"}');
  process.exit(0);
}

emitError("UNSUPPORTED", `Unsupported fake-acpx invocation: ${command.join(" ")}`);
