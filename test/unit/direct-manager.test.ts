import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AcpxSessionManager } from "../../src/manager/acpx.js";
import type { SessionInfo } from "../../src/shared/types.js";
import { createStoreAndRouter, createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

async function resolveWhitespaceFakeAcpxCommand(workspaceDir: string): Promise<string> {
  const fakeAcpxPath = join(workspaceDir, "fake-whitespace-acpx.mjs");
  await writeFile(
    fakeAcpxPath,
    `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const cwdIndex = args.indexOf("--cwd");
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
const commandIndex = args.findIndex((arg) => ["status", "sessions", "prompt"].includes(arg));
const command = commandIndex >= 0 ? args.slice(commandIndex) : [];
const stateDir = join(cwd, ".fake-acpx-state");
mkdirSync(stateDir, { recursive: true });

function emit(value) {
  writeSync(1, JSON.stringify(value) + "\\n");
}

function sessionFile(name) {
  return join(stateDir, \`\${basename(name)}.session\`);
}

if (command[0] === "status" && command[1] === "--session" && command[2]) {
  if (!existsSync(sessionFile(command[2]))) {
    emit({ action: "status_snapshot", status: "no-session", summary: "no active session" });
    process.exit(0);
  }
  emit({ status: "alive", summary: "ready" });
  process.exit(0);
}

if (command[0] === "sessions" && command[1] === "new") {
  const nameIndex = command.indexOf("--name");
  const name = nameIndex >= 0 ? command[nameIndex + 1] : "demo";
  writeFileSync(sessionFile(name), "alive\\n", "utf8");
  emit({ status: "alive" });
  process.exit(0);
}

if (command[0] === "sessions" && command[1] === "show" && command[2]) {
  emit({ messages: [] });
  process.exit(0);
}

if (command[0] === "sessions" && command[1] === "history") {
  emit({ entries: [] });
  process.exit(0);
}

if (command[0] === "prompt" && command[1] === "--session" && command[2]) {
  readFileSync(0, "utf8");
  for (const text of ["Alpha", " beta", " ", "gamma", "\\nNext", " line"]) {
    emit({ type: "agent_message_chunk", content: { type: "text", text } });
  }
  emit({ type: "done" });
  process.exit(0);
}

console.error(\`unsupported fake acpx command: \${command.join(" ")}\`);
process.exit(1);
`,
    "utf8"
  );
  return `node "${fakeAcpxPath.replaceAll('"', '\\"')}"`;
}

async function resolveFakeCodexJsonCommand(workspaceDir: string): Promise<string> {
  const fakeCodexPath = join(workspaceDir, "fake-codex-json.mjs");
  await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
const cwdIndex = args.indexOf("--cd");
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
const counterPath = join(cwd, ".fake-codex-json-count");
const invocation = existsSync(counterPath)
  ? Number.parseInt(readFileSync(counterPath, "utf8"), 10) || 0
  : 0;
writeFileSync(counterPath, String(invocation + 1), "utf8");

let promptText = "";
for await (const chunk of process.stdin) {
  promptText += chunk;
}
const longRunningTurn = invocation > 0;

function emit(value) {
  writeSync(1, JSON.stringify(value) + "\\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

emit({ type: "turn_started" });
writeSync(1, "LIVE RAW PROGRESS\\n");
emit({
  type: "response_item",
  item: {
    type: "function_call",
    name: "exec_command",
    arguments: "{\\"cmd\\":\\"date\\"}"
  }
});
emit({
  type: "response_item",
  item: {
    type: "message",
    tool_calls: [
      {
        type: "function",
        function: {
          name: "mcp__paper_search_mcp__search_pubmed",
          arguments: "{\\"query\\":\\"RSV\\"}"
        }
      }
    ]
  }
});
await sleep(longRunningTurn ? 1500 : 20);
emit({
  type: "response_item",
  item: {
    type: "function_call_output",
    output: "command output line\\nsecond line"
  }
});
await sleep(80);
emit({
  type: "response_item",
  item: {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Final streamed answer." }]
  }
});
if (outputPath != null) {
  writeFileSync(outputPath, "Final file answer.", "utf8");
}
`,
    "utf8"
  );
  return `node "${fakeCodexPath.replaceAll('"', '\\"')}"`;
}

async function resolveFakeCodexFailureCommand(workspaceDir: string): Promise<string> {
  const fakeCodexPath = join(workspaceDir, "fake-codex-failure.mjs");
  await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
const cwdIndex = args.indexOf("--cd");
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
const counterPath = join(cwd, ".fake-codex-failure-count");
const invocation = existsSync(counterPath)
  ? Number.parseInt(readFileSync(counterPath, "utf8"), 10) || 0
  : 0;
writeFileSync(counterPath, String(invocation + 1), "utf8");

for await (const _chunk of process.stdin) {}

function emit(value) {
  writeSync(1, JSON.stringify(value) + "\\n");
}

if (invocation === 0) {
  emit({
    type: "response_item",
    item: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Initial successful report." }]
    }
  });
  if (outputPath != null) {
    writeFileSync(outputPath, "Initial successful report.", "utf8");
  }
  process.exit(0);
}

emit({
  type: "response_item",
  item: {
    type: "function_call",
    name: "exec_command",
    arguments: "{\\"cmd\\":\\"build report\\"}"
  }
});
writeSync(2, "stream disconnected before completion: {\\"error\\":\\"The operation was aborted due to timeout\\"}\\n");
process.exit(1);
`,
    "utf8"
  );
  return `node "${fakeCodexPath.replaceAll('"', '\\"')}"`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("AcpxSessionManager", () => {
  it("starts a session, streams output, and records status", async () => {
    const workspaceDir = await createTempDir("puppenclaw-local-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const chunks: string[] = [];
    outputRouter.attach("demo", async (event) => {
      if (event.kind === "chunk") {
        chunks.push(event.text);
      }
    });

    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    const result = await manager.start({
      agent: "codex",
      name: "demo",
      directory: workspaceDir,
      task: "Implement the server side.",
      contextFiles: []
    });
    const startDetails = result.details as {
      session: SessionInfo;
      output: string;
    };
    expect(startDetails.session.name).toBe("demo");
    expect(startDetails.output).toContain("Handled:");
    expect(chunks.join("")).toContain("Handled:");

    const status = await manager.status({ name: "demo" });
    const statusDetails = status.details as {
      session: SessionInfo;
      runtime: {
        exists: boolean;
      };
    };
    expect(statusDetails.session.name).toBe("demo");
    expect(statusDetails.runtime.exists).toBe(true);
  });

  it("preserves leading and whitespace-only assistant text chunks", async () => {
    const workspaceDir = await createTempDir("puppenclaw-whitespace-");
    const acpxCommand = await resolveWhitespaceFakeAcpxCommand(workspaceDir);
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const chunks: string[] = [];
    outputRouter.attach("whitespace-demo", async (event) => {
      if (event.kind === "chunk") {
        chunks.push(event.text);
      }
    });
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    const result = await manager.start({
      agent: "claude",
      name: "whitespace-demo",
      directory: workspaceDir,
      task: "Emit chunks with leading spaces.",
      contextFiles: []
    });
    const details = result.details as {
      output: string;
    };

    expect(chunks.join("")).toBe("Alpha beta gamma\nNext line");
    expect(details.output).toBe("Alpha beta gamma\nNext line");
  });

  it("exposes live Codex one-shot JSON output while the turn is running", async () => {
    const workspaceDir = await createTempDir("puppenclaw-codex-json-");
    const codexCommand = await resolveFakeCodexJsonCommand(workspaceDir);
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const chunks: string[] = [];
    outputRouter.attach("codex-json-demo", async (event) => {
      if (event.kind === "chunk") {
        chunks.push(event.text);
      }
    });
    const manager = new AcpxSessionManager({
      config: makeConfig({
        agentCommands: {
          codex: codexCommand
        }
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    const modelProvider = {
      id: "fake-openai-compatible",
      kind: "codex-openai-compatible" as const,
      model: "fake-model",
      baseUrl: "http://example.invalid/v1",
      authTokenEnv: "FAKE_CODEX_TOKEN",
      wireApi: "responses" as const
    };

    await manager.start({
      agent: "codex",
      name: "codex-json-demo",
      directory: workspaceDir,
      task: "Prime the one-shot session.",
      contextFiles: [],
      modelProvider
    });
    chunks.length = 0;

    const sendPromise = manager.send({
      name: "codex-json-demo",
      message: "Run a visible tool turn.",
      contextFiles: []
    });

    let liveOutput = "";
    const observedOutputs: Array<{
      attempt: number;
      source: string | undefined;
      complete: boolean | undefined;
      text: string;
    }> = [];
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await sleep(20);
      const output = await manager.output({ name: "codex-json-demo" }).catch(() => null);
      const outputDetails = (output?.details as
        | { output?: { text?: string; source?: string; complete?: boolean } }
        | undefined)?.output;
      liveOutput = outputDetails?.text ?? "";
      if (
        observedOutputs.length === 0 ||
        observedOutputs.at(-1)?.text !== liveOutput ||
        observedOutputs.at(-1)?.source !== outputDetails?.source ||
        observedOutputs.at(-1)?.complete !== outputDetails?.complete
      ) {
        observedOutputs.push({
          attempt,
          source: outputDetails?.source,
          complete: outputDetails?.complete,
          text: liveOutput
        });
      }
      if (liveOutput.includes("[tool] exec_command")) {
        break;
      }
    }

    const result = await sendPromise;
    const details = result.details as {
      output: string;
    };

    expect(
      liveOutput,
      JSON.stringify({ observedOutputs, chunks }, null, 2)
    ).toContain("[tool] exec_command");

    expect(chunks.join("")).toContain("command output line");
    expect(chunks.join("")).toContain("[tool] mcp__paper_search_mcp__search_pubmed");
    expect(details.output).toBe("Final file answer.");
  });

  it("reports a failed Codex follow-up turn instead of stale prior assistant output", async () => {
    const workspaceDir = await createTempDir("puppenclaw-codex-failure-");
    const codexCommand = await resolveFakeCodexFailureCommand(workspaceDir);
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        agentCommands: {
          codex: codexCommand
        }
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });
    const modelProvider = {
      id: "fake-openai-compatible",
      kind: "codex-openai-compatible" as const,
      model: "fake-model",
      baseUrl: "http://example.invalid/v1",
      authTokenEnv: "FAKE_CODEX_TOKEN",
      wireApi: "responses" as const
    };

    await manager.start({
      agent: "codex",
      name: "codex-failure-demo",
      directory: workspaceDir,
      task: "Create the first report.",
      contextFiles: [],
      modelProvider
    });

    const result = await manager.send({
      name: "codex-failure-demo",
      message: "Revise the report.",
      contextFiles: []
    });
    const sendDetails = result.details as {
      session: SessionInfo;
    };
    expect(sendDetails.session.state).toBe("failed");

    const output = await manager.output({ name: "codex-failure-demo" });
    const outputDetails = output.details as {
      output: { text: string; source: string; complete: boolean };
    };
    expect(outputDetails.output.source).toBe("active-turn");
    expect(outputDetails.output.complete).toBe(true);
    expect(outputDetails.output.text).toContain("stream disconnected before completion");
    expect(outputDetails.output.text).toContain("[tool] exec_command");
    expect(outputDetails.output.text).not.toContain("Initial successful report");
  });

  it("marks a session as waiting_input when the reply is a question", async () => {
    const workspaceDir = await createTempDir("puppenclaw-question-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    await manager.start({
      agent: "claude",
      name: "question-demo",
      directory: workspaceDir,
      task: "Prime the session.",
      contextFiles: []
    });

    const result = await manager.send({
      name: "question-demo",
      message: "ASK_USER",
      contextFiles: []
    });
    const sendDetails = result.details as {
      session: SessionInfo;
    };
    expect(sendDetails.session.state).toBe("waiting_input");
    expect(sendDetails.session.pendingQuestion).toBe("Need input from the user?");
  });

  it("creates a runtime session when acpx status reports no-session", async () => {
    const workspaceDir = await createTempDir("puppenclaw-no-session-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    const result = await manager.start({
      agent: "codex",
      name: "fresh-session",
      directory: workspaceDir,
      task: "Reply with exactly OK.",
      contextFiles: []
    });
    const details = result.details as {
      session: SessionInfo;
      output: string;
    };
    expect(details.session.state).toBe("idle");
    expect(details.output).toContain("Handled:");
  });

  it("records planning profiles and injects a plan-first execution prefix", async () => {
    const workspaceDir = await createTempDir("puppenclaw-planning-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    const result = await manager.start({
      agent: "claude",
      name: "planner",
      directory: workspaceDir,
      task: "Implement the whole project end to end.",
      planningProfile: "deep",
      contextFiles: []
    });
    const details = result.details as {
      session: SessionInfo;
      output: string;
    };

    expect(details.session.planningProfile).toBe("deep");
    expect(details.output).toContain("deep planning pass first");
    expect(details.output).toContain("only return to the human");
  });

  it("materializes requested Claude Code skills into the session workspace", async () => {
    const workspaceDir = await createTempDir("puppenclaw-skill-workspace-");
    const skillRoot = await createTempDir("puppenclaw-skill-root-");
    const skillDir = join(skillRoot, "oc-science-lab");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: oc-science-lab\n---\n\n# OC Science Lab\n",
      "utf8"
    );
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand,
        skillRoots: [skillRoot]
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    const result = await manager.start({
      agent: "claude",
      name: "skill-demo",
      directory: workspaceDir,
      task: "Use the lab skill.",
      contextFiles: [],
      skills: ["oc-science-lab"]
    });
    const details = result.details as {
      session: SessionInfo;
      skills: Array<{ name: string; targetPath: string }>;
    };
    const targetPath = join(workspaceDir, ".claude", "skills", "oc-science-lab", "SKILL.md");

    expect(details.session.skills).toEqual(["oc-science-lab"]);
    expect(details.skills[0]?.targetPath).toBe(targetPath);
    await expect(readFile(targetPath, "utf8")).resolves.toContain("# OC Science Lab");
  });

  it("suspends the least-recent idle runtime session at capacity and rehydrates it on send", async () => {
    const workspaceDir = await createTempDir("puppenclaw-eviction-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand,
        maxSessions: 2
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    await manager.start({
      agent: "claude",
      name: "oldest",
      directory: workspaceDir,
      task: "Prime oldest.",
      contextFiles: []
    });
    await manager.start({
      agent: "claude",
      name: "focused",
      directory: workspaceDir,
      task: "Prime focused.",
      contextFiles: []
    });
    await manager.focus({
      name: "focused",
      ttlMs: 60_000
    });
    await manager.start({
      agent: "claude",
      name: "newcomer",
      directory: workspaceDir,
      task: "Prime newcomer.",
      contextFiles: []
    });

    expect(store.getSession("oldest")?.state).toBe("suspended");
    expect(store.getSession("focused")?.state).toBe("idle");

    const result = await manager.send({
      name: "oldest",
      message: "Continue from previous context.",
      contextFiles: []
    });
    const details = result.details as {
      session: SessionInfo;
      output: string;
    };

    expect(details.session.state).toBe("idle");
    expect(details.output).toContain("was disconnected");
    expect(details.output.replaceAll(" ", "")).toContain("Primeoldest.");
    expect(store.getSession("newcomer")?.state).toBe("suspended");
  });

  it("does not evict focused sessions when every connected slot is protected", async () => {
    const workspaceDir = await createTempDir("puppenclaw-focus-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand,
        maxSessions: 1
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    await manager.start({
      agent: "claude",
      name: "focused-only",
      directory: workspaceDir,
      task: "Prime focused.",
      contextFiles: []
    });
    await manager.focus({
      name: "focused-only",
      ttlMs: 60_000
    });

    await expect(
      manager.start({
        agent: "claude",
        name: "blocked",
        directory: workspaceDir,
        task: "This should not evict focused-only.",
        contextFiles: []
      })
    ).rejects.toThrow(/none can be suspended/u);
  });
});
