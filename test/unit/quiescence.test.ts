import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDaemonServer } from "../../src/daemon/server.js";
import { AcpxSessionManager } from "../../src/manager/acpx.js";
import { PuppenclawError } from "../../src/shared/errors.js";
import { SessionStore } from "../../src/shared/store.js";
import type { ToolResult } from "../../src/shared/types.js";
import {
  createStoreAndRouter,
  createTempDir,
  makeConfig,
  resolveFakeAcpxCommand
} from "../helpers.js";

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {}
};

function quiescenceDetails(result: ToolResult): {
  quiescenceEpoch: number;
  runtimeClosed: boolean;
  reservation: { name: string; epoch: number };
} {
  return result.details as {
    quiescenceEpoch: number;
    runtimeClosed: boolean;
    reservation: { name: string; epoch: number };
  };
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      await access(path)
        .then(() => true)
        .catch(() => false)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

describe("session quiescence", () => {
  it("persists monotonic epochs and idempotent release across manager restarts", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-persist-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const firstState = await createStoreAndRouter(workspaceDir);
    const firstManager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger,
      store: firstState.store,
      outputRouter: firstState.outputRouter
    });

    await firstManager.start({
      agent: "claude",
      name: "durable",
      directory: workspaceDir,
      task: "Prime the durable session.",
      contextFiles: []
    });
    const first = quiescenceDetails(await firstManager.quiesce({ name: "durable" }));
    expect(first).toMatchObject({
      quiescenceEpoch: 1,
      runtimeClosed: true,
      reservation: { name: "durable", epoch: 1 }
    });
    await expect(
      firstManager.send({
        name: "durable",
        message: "Do not run.",
        contextFiles: []
      })
    ).rejects.toMatchObject({ code: "SESSION_QUIESCED" });

    const reopenedStore = await SessionStore.open(workspaceDir);
    const reopenedState = await createStoreAndRouter(await createTempDir("puppenclaw-router-"));
    const reopenedManager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger,
      store: reopenedStore,
      outputRouter: reopenedState.outputRouter
    });
    const repeated = quiescenceDetails(await reopenedManager.quiesce({ name: "durable" }));
    expect(repeated.quiescenceEpoch).toBe(1);

    await reopenedManager.purge({ name: "durable" });
    expect(reopenedStore.getSession("durable")).toBeNull();
    await expect(reopenedManager.purge({ name: "durable" })).rejects.toMatchObject({
      code: "NO_SESSION"
    });
    expect(reopenedStore.getActiveQuiescenceEpoch("durable")).toBe(1);
    const afterPurge = quiescenceDetails(await reopenedManager.quiesce({ name: "durable" }));
    expect(afterPurge.quiescenceEpoch).toBe(1);

    const released = await reopenedManager.releaseQuiescence({
      name: "durable",
      epoch: 1
    });
    expect(released.details).toMatchObject({
      released: true,
      quiescenceEpoch: 1,
      reservation: { name: "durable", epoch: 1 }
    });
    await expect(
      reopenedManager.releaseQuiescence({ name: "durable", epoch: 1 })
    ).resolves.toMatchObject({
      details: { released: true, quiescenceEpoch: 1 }
    });
    await expect(
      reopenedManager.releaseQuiescence({ name: "durable", epoch: 2 })
    ).rejects.toMatchObject({ code: "STALE_QUIESCENCE_EPOCH" });

    await reopenedManager.start({
      agent: "claude",
      name: "durable",
      directory: workspaceDir,
      task: "Start again after release.",
      contextFiles: []
    });
    const next = quiescenceDetails(await reopenedManager.quiesce({ name: "durable" }));
    expect(next.quiescenceEpoch).toBe(2);
    await reopenedManager.purge({ name: "durable" });
    await reopenedManager.releaseQuiescence({ name: "durable", epoch: 2 });

    const persisted = JSON.parse(await readFile(join(workspaceDir, "state.json"), "utf8")) as {
      quiescence: { lastEpoch: number; active: Record<string, unknown> };
    };
    expect(persisted.quiescence).toEqual({
      lastEpoch: 2,
      active: {}
    });
  });

  it("bounds released reservation state while retaining a global monotonic epoch", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-bounded-");
    const store = await SessionStore.open(workspaceDir);

    for (let index = 0; index < 25; index += 1) {
      const name = `one-shot-${index}`;
      const reservation = await store.reserveQuiescence(name, "external");
      await store.releaseQuiescence(name, reservation.epoch);
    }

    const persisted = JSON.parse(await readFile(join(workspaceDir, "state.json"), "utf8")) as {
      quiescence: { lastEpoch: number; active: Record<string, unknown> };
    };
    expect(persisted.quiescence).toEqual({ lastEpoch: 25, active: {} });
    await expect(store.releaseQuiescence("one-shot-0", 1)).resolves.toMatchObject({
      name: "one-shot-0",
      epoch: 1
    });
    await expect(store.releaseQuiescence("one-shot-0", 26)).rejects.toMatchObject({
      code: "STALE_QUIESCENCE_EPOCH"
    });

    const newer = await store.reserveQuiescence("one-shot-0", "external");
    expect(newer.epoch).toBe(26);
    await expect(store.releaseQuiescence("one-shot-0", 1)).rejects.toMatchObject({
      code: "STALE_QUIESCENCE_EPOCH"
    });
    expect(store.getActiveQuiescenceEpoch("one-shot-0")).toBe(26);
    await store.releaseQuiescence("one-shot-0", 26);
  });

  it("drains an in-flight turn and prevents it from resurrecting a purged session", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-race-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger,
      store,
      outputRouter
    });

    await manager.start({
      agent: "claude",
      name: "racing",
      directory: workspaceDir,
      task: "Prime the racing session.",
      contextFiles: []
    });
    const sendOutcome = manager
      .send({ name: "racing", message: "SLOW_TURN", contextFiles: [] })
      .then(
        () => null,
        (error: unknown) => error
      );
    await waitForFile(join(workspaceDir, ".fake-acpx-state", "racing.slow"));

    const proof = quiescenceDetails(await manager.quiesce({ name: "racing" }));
    expect(proof.runtimeClosed).toBe(true);
    const sendError = await sendOutcome;
    expect(sendError).toBeInstanceOf(PuppenclawError);
    expect(sendError).toMatchObject({ code: "SESSION_QUIESCED" });

    await manager.purge({ name: "racing" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(store.getSession("racing")).toBeNull();
    expect(store.getActiveQuiescenceEpoch("racing")).toBe(proof.quiescenceEpoch);
    await manager.releaseQuiescence({
      name: "racing",
      epoch: proof.quiescenceEpoch
    });
    expect(store.getSession("racing")).toBeNull();
  });

  it("fences an ambiguous initial start before it can publish a session result", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-start-race-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger,
      store,
      outputRouter
    });

    const startOutcome = manager
      .start({
        agent: "claude",
        name: "ambiguous-start",
        directory: workspaceDir,
        task: "SLOW_TURN",
        contextFiles: []
      })
      .then(
        () => null,
        (error: unknown) => error
      );
    await waitForFile(join(workspaceDir, ".fake-acpx-state", "ambiguous-start.slow"));

    const proof = quiescenceDetails(await manager.quiesce({ name: "ambiguous-start" }));
    expect(proof.runtimeClosed).toBe(true);
    expect(await startOutcome).toMatchObject({ code: "SESSION_QUIESCED" });
    await manager.purge({ name: "ambiguous-start" });
    await manager.releaseQuiescence({
      name: "ambiguous-start",
      epoch: proof.quiescenceEpoch
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(store.getSession("ambiguous-start")).toBeNull();
    await expect(
      access(join(workspaceDir, ".fake-acpx-state", "ambiguous-start.session"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains the same fence when runtime closure must be retried", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-close-retry-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger,
      store,
      outputRouter
    });

    await manager.start({
      agent: "claude",
      name: "retry-close",
      directory: workspaceDir,
      task: "Prime the retry session.",
      contextFiles: []
    });
    await expect(manager.quiesce({ name: "retry-close" })).rejects.toMatchObject({
      code: "QUIESCENCE_UNAVAILABLE"
    });
    expect(store.getActiveQuiescenceEpoch("retry-close")).toBe(1);

    const retried = quiescenceDetails(await manager.quiesce({ name: "retry-close" }));
    expect(retried).toMatchObject({ quiescenceEpoch: 1, runtimeClosed: true });
    await manager.purge({ name: "retry-close" });
    await manager.releaseQuiescence({ name: "retry-close", epoch: 1 });
    expect(store.getActiveQuiescenceEpoch("retry-close")).toBeNull();
  });

  it("exposes authenticated daemon proofs and exact typed lifecycle errors", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-http-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand, daemonAuthToken: "secret-token" }),
      dataDir: workspaceDir,
      logger
    });
    const auth = { authorization: "Bearer secret-token" };

    try {
      const missing = await app.inject({
        method: "POST",
        url: "/session/missing/purge",
        headers: auth
      });
      expect(missing.statusCode).toBe(404);
      expect(JSON.parse(missing.body)).toMatchObject({
        ok: false,
        code: "NO_SESSION",
        error: "Unknown session missing."
      });

      const started = await app.inject({
        method: "POST",
        url: "/session/start",
        headers: auth,
        payload: {
          agent: "claude",
          name: "http-session",
          directory: workspaceDir,
          task: "Prime the HTTP session.",
          contextFiles: []
        }
      });
      expect(started.statusCode).toBe(200);

      const unauthorized = await app.inject({
        method: "POST",
        url: "/session/http-session/quiesce",
        payload: {}
      });
      expect(unauthorized.statusCode).toBe(401);

      const quiesced = await app.inject({
        method: "POST",
        url: "/session/http-session/quiesce",
        headers: auth,
        payload: {}
      });
      expect(quiesced.statusCode).toBe(200);
      const quiescedBody = JSON.parse(quiesced.body) as {
        details: { quiescenceEpoch: number; runtimeClosed: boolean };
      };
      expect(quiescedBody.details).toMatchObject({
        quiescenceEpoch: 1,
        runtimeClosed: true
      });

      const fenced = await app.inject({
        method: "POST",
        url: "/session/http-session/send",
        headers: auth,
        payload: { message: "This must not execute.", contextFiles: [] }
      });
      expect(fenced.statusCode).toBe(409);
      expect(JSON.parse(fenced.body)).toMatchObject({
        ok: false,
        code: "SESSION_QUIESCED"
      });

      const staleRelease = await app.inject({
        method: "POST",
        url: "/session/http-session/quiesce/release",
        headers: auth,
        payload: { epoch: 2 }
      });
      expect(staleRelease.statusCode).toBe(409);
      expect(JSON.parse(staleRelease.body)).toMatchObject({
        ok: false,
        code: "STALE_QUIESCENCE_EPOCH"
      });

      const released = await app.inject({
        method: "POST",
        url: "/session/http-session/quiesce/release",
        headers: auth,
        payload: { epoch: 1 }
      });
      expect(released.statusCode).toBe(200);
      expect(JSON.parse(released.body)).toMatchObject({
        details: { released: true, quiescenceEpoch: 1 }
      });
      const repeatedRelease = await app.inject({
        method: "POST",
        url: "/session/http-session/quiesce/release",
        headers: auth,
        payload: { epoch: 1 }
      });
      expect(repeatedRelease.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
