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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const cwdIndex = args.indexOf("--cwd");
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
const commandIndex = args.findIndex((arg) => ["status", "sessions", "prompt"].includes(arg));
const command = commandIndex >= 0 ? args.slice(commandIndex) : [];
const stateDir = join(cwd, ".fake-acpx-state");
mkdirSync(stateDir, { recursive: true });

function sessionFile(name) {
  return join(stateDir, \`\${basename(name)}.session\`);
}

if (command[0] === "status" && command[1] === "--session" && command[2]) {
  if (!existsSync(sessionFile(command[2]))) {
    console.log(JSON.stringify({ action: "status_snapshot", status: "no-session", summary: "no active session" }));
    process.exit(0);
  }
  console.log(JSON.stringify({ status: "alive", summary: "ready" }));
  process.exit(0);
}

if (command[0] === "sessions" && command[1] === "new") {
  const nameIndex = command.indexOf("--name");
  const name = nameIndex >= 0 ? command[nameIndex + 1] : "demo";
  writeFileSync(sessionFile(name), "alive\\n", "utf8");
  console.log(JSON.stringify({ status: "alive" }));
  process.exit(0);
}

if (command[0] === "prompt" && command[1] === "--session" && command[2]) {
  readFileSync(0, "utf8");
  for (const text of ["Alpha", " beta", " ", "gamma", "\\nNext", " line"]) {
    console.log(JSON.stringify({ type: "agent_message_chunk", content: { type: "text", text } }));
  }
  console.log(JSON.stringify({ type: "done" }));
  process.exit(0);
}

console.error(\`unsupported fake acpx command: \${command.join(" ")}\`);
process.exit(1);
`,
    "utf8"
  );
  return `node "${fakeAcpxPath.replaceAll('"', '\\"')}"`;
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
