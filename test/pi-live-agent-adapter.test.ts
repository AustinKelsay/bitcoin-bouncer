import { describe, expect, it, vi } from "vitest";
import { createPiLiveAgentAdapter } from "../src/pi-live-agent-adapter.js";
import type { PreflightCheck, TxSummary } from "../src/domain.js";

const summary: TxSummary = {
  txid: "abc123",
  vsize: 188,
  weight: 749,
  inputs: 1,
  outputs: 2,
  outputScripts: ["p2tr", "op_return"],
  outputValuesSats: [546, 0],
};
const preflight: PreflightCheck & { allowed: true } = {
  allowed: true,
  feeRateSatVb: 0.4,
};

describe("Pi Live Agent Adapter", () => {
  it("passes the Bouncer Prompt and compact transaction context to Pi and returns a structured action", async () => {
    const client = {
      decide: vi.fn().mockResolvedValue({ action: "shadow_drop", reason: "data-like" }),
    };
    const liveAgent = createPiLiveAgentAdapter({
      client,
      prompt: "You are the Live Agent.",
      promptHash: "sha256:prompt",
      peek: vi.fn(),
      timeoutMs: 1000,
    });

    await expect(
      liveAgent.decide({ rawTx: "020000000001...", summary, preflight }),
    ).resolves.toEqual({ action: "shadow_drop", reason: "data-like" });
    expect(client.decide).toHaveBeenCalledWith({
      prompt: "You are the Live Agent.",
      promptHash: "sha256:prompt",
      transaction: {
        rawTx: "020000000001...",
        summary,
        preflight,
      },
      deepTransactionView: undefined,
    });
  });

  it("allows one peek before requiring a final non-peek action", async () => {
    const deepTransactionView = {
      txid: "abc123",
      rawTx: "020000000001...",
      summary,
      preflight,
    };
    const client = {
      decide: vi
        .fn()
        .mockResolvedValueOnce({ action: "peek" })
        .mockResolvedValueOnce({ action: "tag", label: "normal-after-peek" }),
    };
    const liveAgent = createPiLiveAgentAdapter({
      client,
      prompt: "You are the Live Agent.",
      promptHash: "sha256:prompt",
      peek: vi.fn().mockResolvedValue(deepTransactionView),
      timeoutMs: 1000,
    });

    await expect(
      liveAgent.decide({ rawTx: "020000000001...", summary, preflight }),
    ).resolves.toEqual({ action: "tag", label: "normal-after-peek" });
    expect(client.decide).toHaveBeenLastCalledWith({
      prompt: "You are the Live Agent.",
      promptHash: "sha256:prompt",
      transaction: {
        rawTx: "020000000001...",
        summary,
        preflight,
      },
      deepTransactionView,
    });
  });

  it("falls back to pass when Pi returns a malformed action", async () => {
    const liveAgent = createPiLiveAgentAdapter({
      client: {
        decide: vi.fn().mockResolvedValue({ action: "drop" }),
      },
      prompt: "You are the Live Agent.",
      promptHash: "sha256:prompt",
      peek: vi.fn(),
      timeoutMs: 1000,
    });

    await expect(
      liveAgent.decide({ rawTx: "020000000001...", summary, preflight }),
    ).resolves.toEqual({
      action: "pass",
      reason: "live_agent_fallback: malformed_action",
    });
  });

  it("falls back to pass when Pi peeks more than once or never returns a final action", async () => {
    const liveAgent = createPiLiveAgentAdapter({
      client: {
        decide: vi
          .fn()
          .mockResolvedValueOnce({ action: "peek" })
          .mockResolvedValueOnce({ action: "peek" }),
      },
      prompt: "You are the Live Agent.",
      promptHash: "sha256:prompt",
      peek: vi.fn().mockResolvedValue({
        txid: "abc123",
        rawTx: "020000000001...",
        summary,
        preflight,
      }),
      timeoutMs: 1000,
    });

    await expect(
      liveAgent.decide({ rawTx: "020000000001...", summary, preflight }),
    ).resolves.toEqual({
      action: "pass",
      reason: "live_agent_fallback: tool_limit_violation",
    });
  });
});
