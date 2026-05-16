import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  buildSmokeDirectivePrompt,
  expectedForcedActionOutcome,
  validateForcedActionObservation,
  writeSmokeDirectivePrompt,
} from "../src/forced-action-smoke.js";

describe("Forced-action smoke directives", () => {
  it("layers a Smoke Directive onto the base Bouncer Prompt", () => {
    expect(
      buildSmokeDirectivePrompt({
        basePrompt: "You are the Live Agent.",
        action: "hold",
      }),
    ).toContain("call the `hold` tool exactly once");
  });

  it("writes a generated prompt file for one forced action", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bouncer-smoke-"));

    try {
      const promptPath = await writeSmokeDirectivePrompt({
        directory,
        basePrompt: "You are the Live Agent.",
        action: "shadow_drop",
      });

      await expect(readFile(promptPath, "utf8")).resolves.toContain(
        "call the `shadow_drop` tool exactly once",
      );
      expect(promptPath).toContain("force-shadow_drop");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("defines the expected Shadow Drop smoke outcome", () => {
    expect(expectedForcedActionOutcome("shadow_drop")).toEqual({
      auditOutcome: "shadow_drop",
      propagation: "absent",
      submitterResponse: "txid-only",
      operatorEvidence: "shadow-realm",
    });
  });

  it("rejects a forced action that fell back to pass", () => {
    expect(() =>
      validateForcedActionObservation({
        action: "drop",
        response: {
          status: "submitted",
          txid: "abc123",
          action: "pass",
        },
        audit: {
          events: [
            {
              txid: "abc123",
              outcome: "pass",
              responseBody: {
                status: "submitted",
                txid: "abc123",
                action: "pass",
                internal: {
                  liveAgentFallback: "live_agent_fallback: timeout",
                },
              },
            },
          ],
        },
      }),
    ).toThrow("Expected forced drop, observed pass");
  });
});
