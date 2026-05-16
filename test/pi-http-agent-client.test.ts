import { describe, expect, it, vi } from "vitest";
import { createPiHttpAgentClient } from "../src/pi-http-agent-client.js";

const request = {
  prompt: "You are the Live Agent.",
  promptHash: "sha256:prompt",
  transaction: {
    rawTx: "020000000001...",
    summary: {
      txid: "abc123",
      vsize: 188,
      weight: 749,
      inputs: 1,
      outputs: 2,
      outputScripts: ["p2tr"],
      outputValuesSats: [546],
    },
    preflight: { allowed: true as const },
  },
  deepTransactionView: undefined,
};

describe("Pi HTTP Agent Client", () => {
  it("posts the canonical Bouncer request and accepts a direct Agent Action response", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ action: "pass" }));
    const client = createPiHttpAgentClient({
      url: "http://127.0.0.1:8787/decide",
      fetch,
    });

    await expect(client.decide(request)).resolves.toEqual({ action: "pass" });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:8787/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  });

  it("accepts common structured response envelopes around the Agent Action", async () => {
    const envelopes = [
      { action: { action: "tag", label: "normal" } },
      { decision: { action: "hold", reason: "operator review" } },
      { agentAction: { action: "shadow_drop", reason: "withhold" } },
      { result: { action: "drop", reason: "data-like" } },
    ];

    for (const envelope of envelopes) {
      const fetch = vi.fn().mockResolvedValue(jsonResponse(envelope));
      const client = createPiHttpAgentClient({
        url: "http://127.0.0.1:8787/decide",
        fetch,
      });

      await expect(client.decide(request)).resolves.toEqual(
        Object.values(envelope)[0],
      );
    }
  });

  it("extracts an action from an OpenAI-style output_json envelope", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        output: [
          {
            content: [
              {
                type: "output_json",
                json: { action: "tag", label: "normal" },
              },
            ],
          },
        ],
      }),
    );
    const client = createPiHttpAgentClient({
      url: "http://127.0.0.1:8787/decide",
      fetch,
    });

    await expect(client.decide(request)).resolves.toEqual({
      action: "tag",
      label: "normal",
    });
  });

  it("rejects successful HTTP responses that do not contain a structured action", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ text: "pass it" }));
    const client = createPiHttpAgentClient({
      url: "http://127.0.0.1:8787/decide",
      fetch,
    });

    await expect(client.decide(request)).rejects.toThrow(
      "Pi Agent response did not contain a structured Agent Action",
    );
  });
});

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  };
}
