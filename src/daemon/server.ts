import { join } from "node:path";

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";

import { AcpxSessionManager } from "../manager/acpx.js";
import { OrchestratorRuntime } from "../orchestrator/runtime.js";
import { OrchestratorStore } from "../orchestrator/store.js";
import type { PluginLogger } from "../shared/logger.js";
import { OutputRouter, type OutputRouteEvent } from "../shared/output-router.js";
import { SessionStore } from "../shared/store.js";
import {
  artifactListParamsZod,
  artifactReadParamsZod,
  campaignEventsParamsZod,
  campaignActionParamsZod,
  campaignRunParamsZod,
  campaignStatusParamsZod,
  contextSyncParamsZod,
  costParamsZod,
  focusParamsZod,
  forkParamsZod,
  logsParamsZod,
  projectCreateParamsZod,
  reassessmentReportParamsZod,
  reassessmentStartParamsZod,
  reassessmentStatusParamsZod,
  resumeParamsZod,
  siteStatusParamsZod,
  sendParamsZod,
  startParamsZod,
  statusParamsZod,
  stopParamsZod,
  suspendParamsZod,
  unfocusParamsZod,
  workerManifestZod
} from "../shared/schema.js";
import type { ParsedPluginConfig, ToolResult } from "../shared/types.js";
import { ensureDir } from "../shared/utils.js";

export async function createDaemonServer(params: {
  config: ParsedPluginConfig;
  dataDir: string;
  logger?: PluginLogger;
}): Promise<{
  app: FastifyInstance;
}> {
  await ensureDir(params.dataDir);
  const logger: PluginLogger = params.logger ?? {
    info: (message: string) => console.info(message),
    warn: (message: string) => console.warn(message),
    error: (message: string) => console.error(message),
    debug: (message: string) => console.debug(message)
  };
  const app = Fastify({
    logger: false
  });
  const store = await SessionStore.open(params.dataDir);
  const orchestratorStore = await OrchestratorStore.open(join(params.dataDir, "orchestrator"));
  const outputRouter = new OutputRouter(logger);
  const manager = new AcpxSessionManager({
    config: {
      ...params.config,
      backend: "local"
    },
    logger,
    store,
    outputRouter
  });
  const orchestrator = new OrchestratorRuntime({
    config: {
      ...params.config,
      backend: "local"
    },
    logger,
    store: orchestratorStore,
    sessionStore: store,
    sessionManager: manager
  });

  const ok = (result: ToolResult) => result;

  app.get("/health", async () => ({
    ok: true,
    sessions: store.listSessions().length
  }));

  app.get("/capabilities", async () => ({
    ok: true,
    version: 1,
    sessionStart: true,
    sessionStartStream: true,
    sessionSend: true,
    sessionSendStream: true,
    sessionSuspend: true,
    sessionFocus: true,
    sessionFork: true,
    sessionSkills: true,
    maxSessions: {
      min: 1,
      max: 100,
      current: params.config.maxSessions
    },
    streamOutput: params.config.streamOutput,
    defaultAgent: params.config.defaultAgent
  }));

  app.get("/sessions", async () => ok(await manager.status(statusParamsZod.parse({}))));

  app.get("/skills", async () => ok(await manager.listSkills()));

  app.get("/session/:name", async (request) =>
    ok(
      await manager.status(
        statusParamsZod.parse({
          name: (request.params as { name: string }).name
        })
      )
    )
  );

  app.get("/session/:name/cost", async (request) =>
    ok(
      await manager.cost(
        costParamsZod.parse({
          name: (request.params as { name: string }).name
        })
      )
    )
  );

  app.post("/session/start", async (request) => ok(await manager.start(startParamsZod.parse(request.body))));

  app.post("/session/start/stream", async (request, reply) => {
    const parsed = startParamsZod.parse(request.body);
    return streamToolResult({
      reply,
      sessionName: parsed.name,
      outputRouter,
      run: async () => ok(await manager.start(parsed))
    });
  });

  app.post("/session/:name/send", async (request) =>
    ok(
      await manager.send(
        sendParamsZod.parse({
          ...(request.body as Record<string, unknown>),
          name: (request.params as { name: string }).name
        })
      )
    )
  );

  app.post("/session/:name/send/stream", async (request, reply) => {
    const parsed = sendParamsZod.parse({
      ...(request.body as Record<string, unknown>),
      name: (request.params as { name: string }).name
    });
    return streamToolResult({
      reply,
      sessionName: parsed.name,
      outputRouter,
      run: async () => ok(await manager.send(parsed))
    });
  });

  app.post("/session/:name/resume", async (request) =>
    ok(
      await manager.resume(
        resumeParamsZod.parse({
          name: (request.params as { name: string }).name
        })
      )
    )
  );

  app.post("/session/:name/suspend", async (request) =>
    ok(
      await manager.suspend(
        suspendParamsZod.parse({
          name: (request.params as { name: string }).name
        })
      )
    )
  );

  app.post("/session/:name/focus", async (request) =>
    ok(
      await manager.focus(
        focusParamsZod.parse({
          ...(request.body as Record<string, unknown>),
          name: (request.params as { name: string }).name
        })
      )
    )
  );

  app.post("/session/:name/unfocus", async (request) =>
    ok(
      await manager.unfocus(
        unfocusParamsZod.parse({
          name: (request.params as { name: string }).name
        })
      )
    )
  );

  app.delete("/session/:name", async (request) =>
    ok(
      await manager.stop(
        stopParamsZod.parse({
          name: (request.params as { name: string }).name
        })
      )
    )
  );

  app.post("/session/:name/fork", async (request) =>
    ok(
      await manager.fork(
        forkParamsZod.parse({
          ...(request.body as Record<string, unknown>),
          source: (request.params as { name: string }).name
        })
      )
    )
  );

  app.post("/gc", async () => {
    await manager.gc();
    return { ok: true };
  });

  app.post("/orchestrator/project", async (request) =>
    ok(await orchestrator.createProject(projectCreateParamsZod.parse(request.body)))
  );

  app.post("/orchestrator/worker", async (request) =>
    ok(await orchestrator.registerWorker(workerManifestZod.parse(request.body)))
  );

  app.post("/orchestrator/context-sync", async (request) =>
    ok(await orchestrator.syncContext(contextSyncParamsZod.parse(request.body)))
  );

  app.post("/orchestrator/campaign", async (request) =>
    ok(await orchestrator.runCampaign(campaignRunParamsZod.parse(request.body)))
  );

  app.get("/orchestrator/status", async (request) =>
    ok(
      await orchestrator.status(
        campaignStatusParamsZod.parse({
          campaignId: (request.query as { campaignId?: string }).campaignId,
          projectId: (request.query as { projectId?: string }).projectId
        })
      )
    )
  );

  app.get("/orchestrator/artifacts", async (request) =>
    ok(
      await orchestrator.listArtifacts(
        artifactListParamsZod.parse({
          campaignId: (request.query as { campaignId?: string }).campaignId,
          projectId: (request.query as { projectId?: string }).projectId
        })
      )
    )
  );

  app.get("/orchestrator/artifacts/:artifactId/content", async (request) =>
    ok(
      await orchestrator.readArtifact(
        artifactReadParamsZod.parse({
          artifactId: (request.params as { artifactId: string }).artifactId,
          limitChars:
            (request.query as { limitChars?: string }).limitChars != null
              ? Number((request.query as { limitChars?: string }).limitChars)
              : undefined,
          format: (request.query as { format?: "text" | "json" }).format
        })
      )
    )
  );

  app.get("/orchestrator/events", async (request) =>
    ok(
      await orchestrator.campaignEvents(
        campaignEventsParamsZod.parse({
          campaignId: (request.query as { campaignId?: string }).campaignId,
          after: (request.query as { after?: string }).after,
          limit:
            (request.query as { limit?: string }).limit != null
              ? Number((request.query as { limit?: string }).limit)
              : undefined,
          format: (request.query as { format?: "text" | "json" }).format
        })
      )
    )
  );

  app.post("/orchestrator/approve", async (request) =>
    ok(await orchestrator.approve(campaignActionParamsZod.parse(request.body)))
  );

  app.post("/orchestrator/cancel", async (request) =>
    ok(await orchestrator.cancel(campaignActionParamsZod.parse(request.body)))
  );

  app.post("/orchestrator/reassessment", async (request) =>
    ok(await orchestrator.startReassessment(reassessmentStartParamsZod.parse(request.body)))
  );

  app.get("/orchestrator/reassessment/status", async (request) =>
    ok(
      await orchestrator.reassessmentStatus(
        reassessmentStatusParamsZod.parse({
          reassessmentId: (request.query as { reassessmentId?: string }).reassessmentId,
          projectId: (request.query as { projectId?: string }).projectId,
          format: (request.query as { format?: "text" | "json" }).format
        })
      )
    )
  );

  app.get("/orchestrator/reassessment/report", async (request) =>
    ok(
      await orchestrator.reassessmentReport(
        reassessmentReportParamsZod.parse({
          reassessmentId: (request.query as { reassessmentId?: string }).reassessmentId,
          format: (request.query as { format?: "text" | "json" }).format
        })
      )
    )
  );

  app.get("/site/status", async (request) =>
    ok(
      await orchestrator.siteStatus(
        siteStatusParamsZod.parse({
          verbose: (request.query as { verbose?: string }).verbose === "true",
          format: (request.query as { format?: "text" | "json" }).format
        })
      )
    )
  );

  app.get("/site/logs", async (request) =>
    ok(
      await orchestrator.logs(
        logsParamsZod.parse({
          sessionName: (request.query as { sessionName?: string }).sessionName,
          campaignId: (request.query as { campaignId?: string }).campaignId,
          runId: (request.query as { runId?: string }).runId,
          limitChars:
            (request.query as { limitChars?: string }).limitChars != null
              ? Number((request.query as { limitChars?: string }).limitChars)
              : undefined,
          follow: (request.query as { follow?: string }).follow === "true",
          format: (request.query as { format?: "text" | "json" }).format
        })
      )
    )
  );

  app.post("/shutdown", async (_request, reply) => {
    reply.send({ ok: true });
    queueMicrotask(() => {
      void app.close();
    });
  });

  return { app };
}

async function streamToolResult(params: {
  reply: FastifyReply;
  sessionName: string;
  outputRouter: OutputRouter;
  run: () => Promise<ToolResult>;
}): Promise<FastifyReply> {
  let closed = false;
  params.reply.raw.on("close", () => {
    closed = true;
  });
  params.reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });

  const write = (event: OutputRouteEvent | { kind: "result"; result: ToolResult } | { kind: "done" }): void => {
    if (closed || params.reply.raw.writableEnded) {
      return;
    }
    params.reply.raw.write(`event: ${event.kind}\n`);
    params.reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  params.outputRouter.attach(params.sessionName, (event) => {
    write(event);
  });

  try {
    write({
      kind: "chunk",
      sessionName: params.sessionName,
      text: ""
    });
    const result = await params.run();
    write({ kind: "result", result });
    write({ kind: "done" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    write({
      kind: "error",
      sessionName: params.sessionName,
      text: message
    });
    write({ kind: "done" });
  } finally {
    params.outputRouter.detach(params.sessionName);
    if (!params.reply.raw.writableEnded) {
      params.reply.raw.end();
    }
  }

  return params.reply;
}
