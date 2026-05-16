import { describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleModelClient } from "../src/openai-compatible-model-client.js";

describe("OpenAI-compatible model client", () => {
  it("sends tool definitions to a chat completions endpoint and returns the first tool call", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: "hold",
                    arguments: JSON.stringify({ reason: "operator review" }),
                  },
                },
              ],
            },
          },
        ],
      }),
    });
    const client = createOpenAiCompatibleModelClient({
      baseUrl: "http://127.0.0.1:11434/",
      apiKey: "test-key",
      model: "tool-model",
      fetch,
    });

    await expect(
      client.complete({
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
          preflight: { allowed: true },
        },
        tools: [
          {
            name: "hold",
            description: "Hold transaction",
            parameters: {
              type: "object",
              properties: { reason: { type: "string" } },
              required: ["reason"],
            },
          },
        ],
      }),
    ).resolves.toEqual({
      toolCall: { name: "hold", arguments: { reason: "operator review" } },
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          "content-type": "application/json",
        },
      }),
    );
  });
});
