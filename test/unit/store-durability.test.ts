import { readdir, readFile, writeFile } from "node:fs/promises";
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
    vi.restoreAllMocks();
  });

  it("opens with fresh state and quarantines a corrupt state file", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = await createTempDir("puppenclaw-durability-store-corrupt-");
    await writeFile(join(dir, "state.json"), "not json at all", "utf8");

    const store = await SessionStore.open(dir);

    expect(store.listSessions()).toEqual([]);
    const entries = await readdir(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^state\.json\.corrupt-/u);
  });

  it("quarantines a version-mismatched state file and resets with a warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = await createTempDir("puppenclaw-durability-store-version-");
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({ version: 999, sessions: { legacy: { name: "legacy" } } }),
      "utf8"
    );

    const store = await SessionStore.open(dir);

    expect(store.listSessions()).toEqual([]);
    expect(store.getSession("legacy")).toBeNull();
    const entries = await readdir(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^state\.json\.corrupt-/u);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("version 999");
  });

  it("opens with the fallback state when no state file exists", async () => {
    const dir = await createTempDir("puppenclaw-durability-store-fresh-");

    const store = await SessionStore.open(dir);

    expect(store.listSessions()).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
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
