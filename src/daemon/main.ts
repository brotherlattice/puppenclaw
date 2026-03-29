import { join } from "node:path";

import { PLUGIN_ID } from "../shared/schema.js";
import { ensureDir } from "../shared/utils.js";
import { readPluginConfig } from "../plugin/config.js";
import { createDaemonServer } from "./server.js";

export async function startDaemonServer(params: {
  host?: string;
  port: number;
  dataDir?: string;
  config?: unknown;
}): Promise<{
  close: () => Promise<void>;
}> {
  const config = readPluginConfig(params.config ?? {});
  const dataDir = params.dataDir ?? join(process.cwd(), ".puppenclaw-daemon", PLUGIN_ID);
  await ensureDir(dataDir);
  const { app } = await createDaemonServer({
    config,
    dataDir
  });
  await app.listen({
    host: params.host ?? "127.0.0.1",
    port: params.port
  });
  return {
    close: async () => {
      await app.close();
    }
  };
}
