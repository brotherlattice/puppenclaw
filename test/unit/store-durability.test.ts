import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AcpxSessionManager } from "../../src/manager/acpx.js";
import { SessionStore } from "../../src/shared/store.js";
import {
  readJsonFile,
  readJsonFileResilient,
  writeJsonFileAtomic
} from "../../src/shared/utils.js";
import {
  createStoreAndRouter,
  createTempDir,
  makeConfig,
  resolveFakeAcpxCommand
} from "../helpers.js";

describe("writeJsonFileAtomic", () => {
  it("writes durable content and leaves no temporary files behind", async () => {
    const dir = await createTempDir("puppenclaw-durability-write-");
    const path = join(dir, "state.json");

    await writeJsonFileAtomic(path, { version: 1, sessions: {} });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, sessions: {} });
    const entries = await readdir(dir);
    expect(entries).toEqual(["state.json"]);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("overwrites an existing file in place", async () => {
    const dir = await createTempDir("puppenclaw-durability-overwrite-");
    const path = join(dir, "state.json");

    await writeJsonFileAtomic(path, { generation: 1 });
    await writeJsonFileAtomic(path, { generation: 2 });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ generation: 2 });
    expect(await readdir(dir)).toEqual(["state.json"]);
    expect(await readJsonFile(path, null)).toEqual({ generation: 2 });
  });
});

describe("readJsonFileResilient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the fallback without quarantining when the file is missing", async () => {
    const dir = await createTempDir("puppenclaw-durability-enoent-");
    const path = join(dir, "state.json");

    expect(await readJsonFileResilient(path, { fresh: true })).toEqual({ fresh: true });
    expect(await readdir(dir)).toEqual([]);
  });

  it("quarantines a corrupt file and returns the fallback", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = await createTempDir("puppenclaw-durability-corrupt-");
    const path = join(dir, "state.json");
    await writeFile(path, '{"version": 1, "sessions": {"tru', "utf8");

    expect(await readJsonFileResilient(path, { fresh: true })).toEqual({ fresh: true });
    const entries = await readdir(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^state\.json\.corrupt-/u);
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0]?.[0]).toContain(join(dir, entries[0] ?? ""));
  });
});

describe("SessionStore.open", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens corrupt state in recovery-required mode until an explicit reset", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = await createTempDir("puppenclaw-durability-store-corrupt-");
    await writeFile(join(dir, "state.json"), "not json at all", "utf8");

    const store = await SessionStore.open(dir);

    expect(store.listSessions()).toEqual([]);
    expect(store.getRecoveryStatus()).toMatchObject({ required: true, reason: "corrupt" });
    await expect(
      store.upsertSession({
        agent: "claude",
        name: "must-not-reuse",
        directory: dir,
        state: "idle",
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        permissionMode: "approve-reads",
        warnings: [],
        transcript: []
      })
    ).rejects.toMatchObject({ code: "STATE_RECOVERY_REQUIRED" });
    expect((await readdir(dir)).some((entry) => /^state\.json\.corrupt-/u.test(entry))).toBe(true);

    await expect(store.resetRecovery()).resolves.toEqual({ required: false });
    await expect(store.flush()).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8"))).toMatchObject({
      version: 1,
      sessions: {}
    });
    await store.close();
  });

  it("requires recovery for version-mismatched and structurally invalid state", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = await createTempDir("puppenclaw-durability-store-version-");
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({ version: 999, sessions: { legacy: { name: "legacy" } } }),
      "utf8"
    );

    const store = await SessionStore.open(dir);

    expect(store.listSessions()).toEqual([]);
    expect(store.getSession("legacy")).toBeNull();
    expect(store.getRecoveryStatus()).toMatchObject({
      required: true,
      reason: "incompatible"
    });
    await store.close();

    const invalidDir = await createTempDir("puppenclaw-durability-store-invalid-");
    await writeFile(
      join(invalidDir, "state.json"),
      JSON.stringify({
        version: 1,
        sessions: { damaged: { name: "damaged", state: "running" } },
        exposures: {},
        quiescence: { lastEpoch: 0, active: {}, latestByName: {} }
      }),
      "utf8"
    );
    const invalidStore = await SessionStore.open(invalidDir);
    expect(invalidStore.getRecoveryStatus()).toMatchObject({ required: true, reason: "invalid" });
    await invalidStore.close();
  });

  it("opens with the fallback state when no state file exists", async () => {
    const dir = await createTempDir("puppenclaw-durability-store-fresh-");

    const store = await SessionStore.open(dir);

    expect(store.listSessions()).toEqual([]);
    expect(store.getRecoveryStatus()).toEqual({ required: false });
    expect(await readdir(dir)).toEqual([".state-owner.json"]);
    await store.close();
    expect(await readdir(dir)).toEqual([]);
  });

  it("stays read-only when corrupt state cannot be quarantined", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T01:02:03.004Z"));
    const dir = await createTempDir("puppenclaw-durability-unquarantinable-");
    await writeFile(join(dir, "state.json"), "{broken", "utf8");
    await mkdir(join(dir, "state.json.corrupt-2026-08-12T01-02-03.004Z"));

    const store = await SessionStore.open(dir);

    expect(store.getRecoveryStatus()).toMatchObject({ required: true, reason: "corrupt" });
    expect(await readFile(join(dir, "state.json"), "utf8")).toBe("{broken");
    await expect(store.reserveQuiescence("unsafe", "external")).rejects.toMatchObject({
      code: "STATE_RECOVERY_REQUIRED"
    });
    await store.close();
    vi.useRealTimers();
  });

  it("allows only one live owner and safely takes over a stale owner lease", async () => {
    const dir = await createTempDir("puppenclaw-durability-owner-");
    const owner = await SessionStore.open(dir);

    await expect(SessionStore.open(dir)).rejects.toMatchObject({ code: "STATE_ROOT_IN_USE" });
    await owner.close();

    await writeFile(
      join(dir, ".state-owner.json"),
      JSON.stringify({
        version: 1,
        ownerId: "stale-owner",
        pid: 999_999_999,
        processStartIdentity: "999999999:1",
        acquiredAt: "2026-08-12T00:00:00.000Z"
      }),
      "utf8"
    );
    const replacement = await SessionStore.open(dir);
    expect(replacement.getRecoveryStatus()).toEqual({ required: false });
    expect((await readdir(dir)).some((entry) => entry.startsWith(".state-owner.json.stale-"))).toBe(
      true
    );
    await replacement.close();
  });
});

describe("startup reconciliation", () => {
  const silentLogger = {
    info() {},
    warn() {},
    error() {},
    debug() {}
  };

  it("marks a persisted running session with a dead turn process as failed", async () => {
    const workspaceDir = await createTempDir("puppenclaw-durability-startup-sweep-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const timestamp = new Date().toISOString();
    await store.upsertSession({
      agent: "claude",
      name: "dead-turn",
      directory: workspaceDir,
      state: "running",
      createdAt: timestamp,
      lastActivity: timestamp,
      permissionMode: "approve-reads",
      warnings: [],
      transcript: [],
      activeTurn: {
        id: "turn-dead",
        state: "running",
        startedAt: timestamp,
        updatedAt: timestamp,
        pid: 999_999_999,
        processStartIdentity: "999999999:0",
        outputChars: 0
      }
    });

    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      logger: silentLogger,
      store,
      outputRouter
    });
    await manager.reconcilePersistedSessions();

    const session = store.getSession("dead-turn");
    expect(session?.state).toBe("failed");
    expect(session?.activeTurn?.state).toBe("orphaned");
    expect(session?.lastStopReason).toBe("Interrupted by daemon restart");
    expect(
      JSON.parse(await readFile(join(workspaceDir, "state.json"), "utf8"))
    ).toMatchObject({ sessions: { "dead-turn": { state: "failed" } } });
  });

  it("keeps sessions without running state or with quiescence fencing untouched", async () => {
    const workspaceDir = await createTempDir("puppenclaw-durability-startup-skip-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const timestamp = new Date().toISOString();
    await store.upsertSession({
      agent: "claude",
      name: "idle-session",
      directory: workspaceDir,
      state: "idle",
      createdAt: timestamp,
      lastActivity: timestamp,
      permissionMode: "approve-reads",
      warnings: [],
      transcript: []
    });
    await store.upsertSession({
      agent: "claude",
      name: "fenced-session",
      directory: workspaceDir,
      state: "running",
      createdAt: timestamp,
      lastActivity: timestamp,
      permissionMode: "approve-reads",
      warnings: [],
      transcript: []
    });
    await store.reserveQuiescence("fenced-session", "external");

    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      logger: silentLogger,
      store,
      outputRouter
    });
    await manager.reconcilePersistedSessions();

    expect(store.getSession("idle-session")?.state).toBe("idle");
    expect(store.getSession("fenced-session")?.state).toBe("running");
  });
});
