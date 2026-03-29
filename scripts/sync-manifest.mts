import { rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildPluginManifest } from "../src/shared/schema.ts";

const manifestPath = resolve(process.cwd(), "openclaw.plugin.json");
const manifest = buildPluginManifest();

await writeFile(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await rename(`${manifestPath}.tmp`, manifestPath);
