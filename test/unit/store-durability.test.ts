import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readJsonFile, writeJsonFileAtomic } from "../../src/shared/utils.js";
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
