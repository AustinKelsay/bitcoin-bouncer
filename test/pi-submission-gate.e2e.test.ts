import { describe, expect, it, vi } from "vitest";
import { buildBouncerApi } from "../src/app.js";
import { createOpenAiCompatibleModelClient } from "../src/openai-compatible-model-client.js";
import { createPiLiveAgentAdapter } from "../src/pi-live-agent-adapter.js";
import type {
  BouncerStateStore,
  GateNode,
  PreflightCheck,
  TxSummary,
} from "../src/domain.js";

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

describe.concurrent("Pi-backed Submission Gate", () => {
  it.each([
    {
      toolName: "pass",
      toolArguments: {},
      gateSubmission: { txid: "abc123" },
      expectedStatus: 200,
      expectedBody: {
        status: "submitted",
        txid: "abc123",
        action: "pass",
      },
      expectedOutcome: "pass",
      expectedSubmitted: true,
    },
    {
      toolName: "tag",
      toolArguments: { label: "low-fee-normal" },
      gateSubmission: { txid: "abc123" },
      expectedStatus: 200,
      expectedBody: {
        status: "submitted",
        txid: "abc123",
        action: "tag",
        label: "low-fee-normal",
      },
      expectedOutcome: "tag",
      expectedSubmitted: true,
    },
    {
      toolName: "hold",
      toolArguments: { reason: "operator review" },
      gateSubmission: undefined,
      expectedStatus: 202,
      expectedBody: {
        status: "held",
        txid: "abc123",
        holdId: "hold_abc123",
        reason: "operator review",
      },
      expectedOutcome: "hold",
      expectedSubmitted: false,
    },
    {
      toolName: "drop",
      toolArguments: { reason: "data-like transaction" },
      gateSubmission: undefined,
      expectedStatus: 403,
      expectedBody: {
        status: "dropped",
        txid: "abc123",
        reason: "data-like transaction",
      },
      expectedOutcome: "drop",
      expectedSubmitted: false,
    },
    {
      toolName: "shadow_drop",
      toolArguments: { reason: "withhold but return txid" },
      gateSubmission: undefined,
      expectedStatus: 200,
      expectedBody: { txid: "abc123" },
      expectedOutcome: "shadow_drop",
      expectedSubmitted: false,
    },
  ])(
    "applies a $toolName tool call through the public submit path",
    async ({
      toolName,
      toolArguments,
      gateSubmission,
      expectedStatus,
      expectedBody,
      expectedOutcome,
      expectedSubmitted,
    }) => {
      const gateNode: GateNode = {
        summarize: vi.fn().mockResolvedValue(summary),
        preflight: vi.fn().mockResolvedValue(preflight),
        submit: vi.fn().mockResolvedValue(gateSubmission),
      };
      const stateStore: BouncerStateStore = {
        findIdempotencyRecord: vi.fn().mockResolvedValue(undefined),
        rememberIdempotencyRecord: vi.fn(),
        recordAuditEvent: vi.fn(),
        recordTag: vi.fn(),
        hold: vi.fn().mockResolvedValue({ holdId: "hold_abc123" }),
        shadowDrop: vi.fn(),
        reset: vi.fn(),
      };
      const app = buildBouncerApi({
        gateNode,
        liveAgent: createLiveAgentFromToolCalls([
          { name: toolName, args: toolArguments },
        ]),
        stateStore,
        runtime: {
          promptHash: "sha256:prompt",
          gateNodeName: "backend1",
          propagationWitnessNames: ["backend2", "backend3"],
        },
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/transactions",
        payload: { rawTx: "020000000001..." },
      });

      expect(response.statusCode).toBe(expectedStatus);
      expect(response.json()).toEqual(expectedBody);
      expect(stateStore.recordAuditEvent).toHaveBeenCalledWith({
        txid: "abc123",
        outcome: expectedOutcome,
        responseBody: expectedBody,
        promptHash: "sha256:prompt",
      });

      if (expectedSubmitted) {
        expect(gateNode.submit).toHaveBeenCalledWith("020000000001...");
      } else {
        expect(gateNode.submit).not.toHaveBeenCalled();
      }
    },
  );

  it("withholds a shadow-dropped transaction after one model peek", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn().mockResolvedValue(summary),
      preflight: vi.fn().mockResolvedValue(preflight),
      submit: vi.fn(),
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(chatCompletionToolCall("peek", {}))
      .mockResolvedValueOnce(
        chatCompletionToolCall("shadow_drop", {
          reason: "data-like transaction after deep view",
        }),
      );
    const stateStore: BouncerStateStore = {
      findIdempotencyRecord: vi.fn().mockResolvedValue(undefined),
      rememberIdempotencyRecord: vi.fn(),
      recordAuditEvent: vi.fn(),
      recordTag: vi.fn(),
      hold: vi.fn(),
      shadowDrop: vi.fn(),
      reset: vi.fn(),
    };
    const liveAgent = createPiLiveAgentAdapter({
      model: createOpenAiCompatibleModelClient({
        baseUrl: "http://127.0.0.1:11434",
        apiKey: "test-key",
        model: "tool-model",
        fetch,
      }),
      prompt: "Use Bouncer-native tools.",
      promptHash: "sha256:prompt",
      timeoutMs: 1000,
      async peek(transaction) {
        return {
          txid: transaction.summary.txid,
          rawTx: transaction.rawTx,
          summary: transaction.summary,
          preflight: transaction.preflight,
        };
      },
    });
    const app = buildBouncerApi({
      gateNode,
      liveAgent,
      stateStore,
      runtime: {
        promptHash: "sha256:prompt",
        gateNodeName: "backend1",
        propagationWitnessNames: ["backend2", "backend3"],
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/transactions",
      payload: { rawTx: "020000000001..." },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ txid: "abc123" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(secondModelRequest(fetch).tools).not.toContainEqual(
      expect.objectContaining({
        function: expect.objectContaining({ name: "peek" }),
      }),
    );
    expect(gateNode.submit).not.toHaveBeenCalled();
    expect(stateStore.shadowDrop).toHaveBeenCalledWith({
      rawTx: "020000000001...",
      txid: "abc123",
      reason: "data-like transaction after deep view",
      summary,
    });
    expect(stateStore.recordAuditEvent).toHaveBeenCalledWith({
      txid: "abc123",
      outcome: "shadow_drop",
      responseBody: { txid: "abc123" },
      promptHash: "sha256:prompt",
    });
  });

  it("passes submitter-cleanly while auditing malformed model tool calls", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn().mockResolvedValue(summary),
      preflight: vi.fn().mockResolvedValue(preflight),
      submit: vi.fn().mockResolvedValue({ txid: "abc123" }),
    };
    const stateStore: BouncerStateStore = {
      findIdempotencyRecord: vi.fn().mockResolvedValue(undefined),
      rememberIdempotencyRecord: vi.fn(),
      recordAuditEvent: vi.fn(),
      recordTag: vi.fn(),
      hold: vi.fn(),
      shadowDrop: vi.fn(),
      reset: vi.fn(),
    };
    const app = buildBouncerApi({
      gateNode,
      liveAgent: createLiveAgentFromToolCalls([{ name: "drop", args: {} }]),
      stateStore,
      runtime: {
        promptHash: "sha256:prompt",
        gateNodeName: "backend1",
        propagationWitnessNames: [],
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/transactions",
      payload: { rawTx: "020000000001..." },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "submitted",
      txid: "abc123",
      action: "pass",
    });
    expect(stateStore.recordAuditEvent).toHaveBeenCalledWith({
      txid: "abc123",
      outcome: "pass",
      responseBody: {
        status: "submitted",
        txid: "abc123",
        action: "pass",
        internal: {
          liveAgentFallback: "live_agent_fallback: malformed_action",
        },
      },
      promptHash: "sha256:prompt",
    });
  });
});

function createLiveAgentFromToolCalls(
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
) {
  const fetch = vi.fn(async () => {
    const toolCall = toolCalls.shift() ?? { name: "pass", args: {} };

    return chatCompletionToolCall(toolCall.name, toolCall.args);
  });

  return createPiLiveAgentAdapter({
    model: createOpenAiCompatibleModelClient({
      baseUrl: "http://127.0.0.1:11434",
      apiKey: "test-key",
      model: "tool-model",
      fetch,
    }),
    prompt: "Use Bouncer-native tools.",
    promptHash: "sha256:prompt",
    timeoutMs: 1000,
    async peek(transaction) {
      return {
        txid: transaction.summary.txid,
        rawTx: transaction.rawTx,
        summary: transaction.summary,
        preflight: transaction.preflight,
      };
    },
  });
}

function chatCompletionToolCall(name: string, args: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name,
                  arguments: JSON.stringify(args),
                },
              },
            ],
          },
        },
      ],
    }),
  };
}

function secondModelRequest(fetch: ReturnType<typeof vi.fn>) {
  return JSON.parse(fetch.mock.calls[1][1].body) as {
    tools: Array<{ function: { name: string } }>;
  };
}
