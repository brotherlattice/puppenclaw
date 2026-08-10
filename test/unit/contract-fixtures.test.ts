import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONTRACT_FIXTURES_DIR,
  CONTRACT_SCENARIOS,
  generateContractFixtures
} from "../../scripts/emit-contract-fixtures.js";

const REGENERATE_HINT =
  "regenerate with `npx tsx scripts/emit-contract-fixtures.ts` if the change is intentional";

describe.runIf(process.platform === "linux")("contract fixtures", () => {
  it("matches the committed status and output envelopes", async () => {
    const captures = await generateContractFixtures();
    for (const scenario of CONTRACT_SCENARIOS) {
      const committedStatus = JSON.parse(
        await readFile(join(CONTRACT_FIXTURES_DIR, `${scenario}.status.json`), "utf8")
      ) as unknown;
      const committedOutput = JSON.parse(
        await readFile(join(CONTRACT_FIXTURES_DIR, `${scenario}.output.json`), "utf8")
      ) as unknown;
      expect(
        captures[scenario].status,
        `${scenario}.status.json drifted; ${REGENERATE_HINT}`
      ).toEqual(committedStatus);
      expect(
        captures[scenario].output,
        `${scenario}.output.json drifted; ${REGENERATE_HINT}`
      ).toEqual(committedOutput);
    }
  }, 30_000);

  it("commits exactly one status and one output fixture per scenario", async () => {
    const committed = (await readdir(CONTRACT_FIXTURES_DIR)).sort();
    const expected = CONTRACT_SCENARIOS.flatMap((scenario) => [
      `${scenario}.output.json`,
      `${scenario}.status.json`
    ]).sort();
    expect(committed).toEqual(expected);
  });
});
