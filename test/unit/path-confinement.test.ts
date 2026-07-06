import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { confineToRoot } from "../../src/shared/utils.js";

describe("confineToRoot", () => {
  const base = resolve(tmpdir(), "puppenclaw-confine-base");
  const root = join(base, "proj");

  it("accepts an in-root relative path and returns the resolved absolute path", () => {
    expect(confineToRoot(root, join("sub", "file.txt"))).toBe(join(root, "sub", "file.txt"));
    expect(confineToRoot(root, "README.md")).toBe(join(root, "README.md"));
  });

  it("accepts the root itself", () => {
    expect(confineToRoot(root, ".")).toBe(root);
  });

  it("accepts an in-root absolute path", () => {
    const nested = join(root, "nested", "deep.txt");
    expect(confineToRoot(root, nested)).toBe(nested);
  });

  it("returns a resolved absolute path for a legit nested path", () => {
    const confined = confineToRoot(root, join("a", "b", "c.json"));
    expect(confined).not.toBeNull();
    expect(confined).toBe(resolve(root, "a", "b", "c.json"));
  });

  it("rejects absolute paths outside the root", () => {
    expect(confineToRoot(root, "/etc/passwd")).toBeNull();
    expect(confineToRoot(root, join(base, "elsewhere", "file.txt"))).toBeNull();
    if (process.platform === "win32") {
      expect(confineToRoot(root, "C:\\Windows\\System32\\drivers\\etc\\hosts")).toBeNull();
    }
  });

  it("rejects any '..' traversal regardless of separator style", () => {
    expect(confineToRoot(root, "../x")).toBeNull();
    expect(confineToRoot(root, "..\\x")).toBeNull();
    expect(confineToRoot(root, join("sub", "..", "..", "x"))).toBeNull();
    expect(confineToRoot(root, "..")).toBeNull();
  });

  it("does not treat a sibling-prefix directory as contained", () => {
    const evil = `${root}-evil`;
    expect(confineToRoot(root, evil)).toBeNull();
    expect(confineToRoot(root, join(evil, "file.txt"))).toBeNull();
  });

  it("compares case-insensitively on win32", () => {
    if (process.platform !== "win32") {
      return;
    }
    const upperCandidate = join(root.toUpperCase(), "file.txt");
    expect(confineToRoot(root, upperCandidate)).toBe(upperCandidate);
  });
});
