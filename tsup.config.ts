import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "index.ts",
    "daemon/cli": "src/daemon/cli.ts",
    "daemon/main": "src/daemon/main.ts",
    "compute/supervisor-cli": "src/compute/supervisor-cli.ts"
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: true,
  sourcemap: true,
  clean: true,
  bundle: true,
  skipNodeModulesBundle: false,
  splitting: false,
  outDir: "dist",
  external: ["openclaw"]
});
