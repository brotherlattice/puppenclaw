import { describe, expect, it } from "vitest";

import { OutputRouter } from "../../src/plugin/output-router.js";
import type { OutputRouteEvent } from "../../src/plugin/output-router.js";

describe("OutputRouter", () => {
  it("buffers until newline and flushes trailing text on completion", async () => {
    const events: OutputRouteEvent[] = [];
    const router = new OutputRouter({
      info() {},
      warn() {},
      error() {},
      debug() {}
    });
    router.attach("demo", async (event) => {
      events.push(event);
    });

    await router.onChunk("demo", "hello");
    await router.onChunk("demo", " world\nnext");
    await router.onComplete("demo", "Turn completed.");

    expect(events).toEqual([
      {
        kind: "chunk",
        sessionName: "demo",
        text: "hello world\n"
      },
      {
        kind: "chunk",
        sessionName: "demo",
        text: "next"
      },
      {
        kind: "complete",
        sessionName: "demo",
        text: "Turn completed."
      }
    ]);
  });
});
