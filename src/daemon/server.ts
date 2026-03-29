import Fastify, { type FastifyInstance } from "fastify";
import type { PluginLogger } from "openclaw/plugin-sdk/core";

import { AcpxSessionManager } from "../manager/acpx.js";
import { SessionStore } from "../shared/store.js";
import {
  costParamsZod,
  forkParamsZod,
  resumeParamsZod,
  sendParamsZod,
  startParamsZod,
  statusParamsZod,
  stopParamsZod
} from "../shared/schema.js";
import type { ParsedPluginConfig, ToolResult } from "../shared/types.js";
import { ensureDir } from "../shared/utils.js";
import { OutputRouter } from "../plugin/output-router.js";

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

  const ok = (result: ToolResult) => result;

  app.get("/health", async () => ({
    ok: true,
    sessions: store.listSessions().length
  }));

  app.get("/sessions", async () => ok(await manager.status(statusParamsZod.parse({}))));

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

  app.post("/session/:name/resume", async (request) =>
    ok(
      await manager.resume(
        resumeParamsZod.parse({
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

  app.post("/shutdown", async (_request, reply) => {
    reply.send({ ok: true });
    queueMicrotask(() => {
      void app.close();
    });
  });

  return { app };
}
