import { describe, expect, it } from "vitest";

import { createDaemonServer } from "../../src/daemon/server.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

describe("daemon auth", () => {
  it("requires a bearer token on protected routes when daemonAuthToken is configured", async () => {
    const workspaceDir = await createTempDir("puppenclaw-daemon-auth-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const config = makeConfig({
      acpxCommand,
      daemonAuthToken: "secret-token"
    });

    const { app } = await createDaemonServer({
      config,
      dataDir: workspaceDir
    });

    try {
      // Health and capabilities stay open for probes even with auth enabled.
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      const capabilities = await app.inject({ method: "GET", url: "/capabilities" });
      expect(capabilities.statusCode).toBe(200);

      // Reads without the header are rejected.
      const sessions = await app.inject({ method: "GET", url: "/sessions" });
      expect(sessions.statusCode).toBe(401);
      expect(JSON.parse(sessions.body)).toEqual({ ok: false, error: "unauthorized" });

      const usage = await app.inject({ method: "GET", url: "/usage" });
      expect(usage.statusCode).toBe(401);
      const computeCapacity = await app.inject({
        method: "GET",
        url: "/compute/capacity"
      });
      expect(computeCapacity.statusCode).toBe(401);

      // Writes without the header are rejected.
      const gc = await app.inject({ method: "POST", url: "/gc" });
      expect(gc.statusCode).toBe(401);
      const shutdown = await app.inject({ method: "POST", url: "/shutdown" });
      expect(shutdown.statusCode).toBe(401);
      const campaign = await app.inject({
        method: "POST",
        url: "/orchestrator/campaign",
        payload: {}
      });
      expect(campaign.statusCode).toBe(401);

      // Wrong token is rejected.
      const wrongToken = await app.inject({
        method: "GET",
        url: "/sessions",
        headers: { authorization: "Bearer wrong-token" }
      });
      expect(wrongToken.statusCode).toBe(401);

      // Correct token is accepted.
      const authorized = await app.inject({
        method: "GET",
        url: "/sessions",
        headers: { authorization: "Bearer secret-token" }
      });
      expect(authorized.statusCode).toBe(200);

      const authorizedGc = await app.inject({
        method: "POST",
        url: "/gc",
        headers: { authorization: "Bearer secret-token" }
      });
      expect(authorizedGc.statusCode).toBe(200);
      expect(JSON.parse(authorizedGc.body)).toEqual({ ok: true });

      const authorizedUsage = await app.inject({
        method: "GET",
        url: "/usage",
        headers: { authorization: "Bearer secret-token" }
      });
      expect(authorizedUsage.statusCode).toBe(200);
      const authorizedComputeCapacity = await app.inject({
        method: "GET",
        url: "/compute/capacity",
        headers: { authorization: "Bearer secret-token" }
      });
      expect(authorizedComputeCapacity.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("stays fully open when no daemonAuthToken is configured", async () => {
    const workspaceDir = await createTempDir("puppenclaw-daemon-open-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const config = makeConfig({ acpxCommand });

    const { app } = await createDaemonServer({
      config,
      dataDir: workspaceDir
    });

    try {
      const sessions = await app.inject({ method: "GET", url: "/sessions" });
      expect(sessions.statusCode).toBe(200);
      const gc = await app.inject({ method: "POST", url: "/gc" });
      expect(gc.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("treats an empty daemonAuthToken as no auth", async () => {
    const workspaceDir = await createTempDir("puppenclaw-daemon-empty-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const config = makeConfig({
      acpxCommand,
      daemonAuthToken: ""
    });

    const { app } = await createDaemonServer({
      config,
      dataDir: workspaceDir
    });

    try {
      const sessions = await app.inject({ method: "GET", url: "/sessions" });
      expect(sessions.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
