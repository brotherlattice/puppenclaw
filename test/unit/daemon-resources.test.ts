import { describe, expect, it } from "vitest";

import { createDaemonServer } from "../../src/daemon/server.js";
import { SessionStore } from "../../src/shared/store.js";
import type { SessionInfo } from "../../src/shared/types.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

const AUTH = { authorization: "Bearer secret-token" };

function seedSession(name: string): SessionInfo {
  const now = new Date().toISOString();
  return {
    name,
    agent: "claude",
    directory: "/tmp",
    state: "idle",
    createdAt: now,
    lastActivity: now,
    permissionMode: "approve-reads",
    warnings: [],
    transcript: []
  };
}

describe("daemon resource endpoints", () => {
  it("serves resource payloads with bearer auth, session lookup, and validation", async () => {
    const dataDir = await createTempDir("puppenclaw-daemon-resources-");
    const seedStore = await SessionStore.open(dataDir);
    await seedStore.upsertSession(seedSession("chat-a"));
    const { app } = await createDaemonServer({
      config: makeConfig({
        acpxCommand: await resolveFakeAcpxCommand(),
        daemonAuthToken: "secret-token"
      }),
      dataDir
    });
    try {
      // 401 without the bearer token.
      for (const url of [
        "/resources",
        "/resources/history",
        "/session/chat-a/processes"
      ]) {
        const denied = await app.inject({ method: "GET", url });
        expect(denied.statusCode, url).toBe(401);
      }

      // Unknown session -> 404 NO_SESSION.
      const missing = await app.inject({
        method: "GET",
        url: "/session/does-not-exist/processes",
        headers: AUTH
      });
      expect(missing.statusCode).toBe(404);
      expect(JSON.parse(missing.body)).toMatchObject({ ok: false, code: "NO_SESSION" });

      // Live processes payload shape (2-sample window ~400ms).
      const processes = await app.inject({
        method: "GET",
        url: "/session/chat-a/processes",
        headers: AUTH
      });
      expect(processes.statusCode).toBe(200);
      const processesBody = JSON.parse(processes.body) as {
        content: Array<{ type: string; text: string }>;
        details: Record<string, unknown>;
      };
      expect(processesBody.content[0]?.type).toBe("text");
      expect(processesBody.details).toMatchObject({
        name: "chat-a",
        supported: process.platform === "linux",
        roots: { turnPid: null, computeJobs: [] },
        totals: { cpuPct: 0, rssBytes: 0, processCount: 0 }
      });
      expect(typeof processesBody.details.sampledAt).toBe("string");
      expect(typeof processesBody.details.sampleWindowMs).toBe("number");
      expect(Array.isArray(processesBody.details.processes)).toBe(true);

      // Snapshot payload shape. Retry briefly: the daemon's startup tick may
      // still be in flight right after server creation.
      let snapshot: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const response = await app.inject({ method: "GET", url: "/resources", headers: AUTH });
        expect(response.statusCode).toBe(200);
        snapshot = (JSON.parse(response.body) as { details: Record<string, unknown> }).details;
        if (Array.isArray(snapshot.sessions) && snapshot.sessions.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(snapshot).not.toBeNull();
      expect(snapshot).toMatchObject({
        supported: true,
        samplingIntervalMs: 30_000
      });
      expect(typeof snapshot?.sampledAt).toBe("string");
      const sessions = snapshot?.sessions as Array<Record<string, unknown>>;
      expect(sessions.some((entry) => entry.name === "chat-a")).toBe(true);
      expect(snapshot?.unlinkedCompute).toMatchObject({ jobCount: 0 });
      expect(snapshot?.totals).toMatchObject({});
      expect(snapshot?.host).not.toBeNull();

      // History payload shape.
      const history = await app.inject({
        method: "GET",
        url: "/resources/history?bucketSeconds=60",
        headers: AUTH
      });
      expect(history.statusCode).toBe(200);
      const historyBody = (JSON.parse(history.body) as { details: Record<string, unknown> })
        .details;
      expect(historyBody).toMatchObject({ bucketSeconds: 60, retentionDays: 7 });
      expect(typeof historyBody.since).toBe("string");
      expect(typeof historyBody.until).toBe("string");
      expect(Array.isArray(historyBody.sessions)).toBe(true);
      expect(Array.isArray(historyBody.host)).toBe(true);
      expect(Array.isArray(historyBody.totals)).toBe(true);

      // Session filter passes through.
      const filtered = await app.inject({
        method: "GET",
        url: "/resources/history?bucketSeconds=60&session=chat-a",
        headers: AUTH
      });
      expect(filtered.statusCode).toBe(200);

      // Invalid ranges and params are client errors, not 500s.
      const inverted = await app.inject({
        method: "GET",
        url: "/resources/history?since=2026-01-02T00:00:00.000Z&until=2026-01-01T00:00:00.000Z",
        headers: AUTH
      });
      expect(inverted.statusCode).toBe(400);
      expect(JSON.parse(inverted.body)).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
      const badBucket = await app.inject({
        method: "GET",
        url: "/resources/history?bucketSeconds=abc",
        headers: AUTH
      });
      expect(badBucket.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  }, 30_000);
});
