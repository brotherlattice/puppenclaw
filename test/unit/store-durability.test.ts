import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionStore } from "../../src/shared/store.js";
import {
  readJsonFile,
  readJsonFileResilient,
  writeJsonFileAtomic
} from "../../src/shared/utils.js";
import { createTempDir } from "../helpers.js";

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
