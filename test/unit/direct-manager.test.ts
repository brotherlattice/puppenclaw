import { describe, expect, it } from "vitest";

import { AcpxSessionManager } from "../../src/manager/acpx.js";
import type { SessionInfo } from "../../src/shared/types.js";
import { createStoreAndRouter, createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

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
});
