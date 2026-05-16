import { describe, expect, it, vi } from "vitest";
import { buildBouncerApi } from "../src/app.js";
import type {
  BouncerStateStore,
  GateNode,
  LiveAgent,
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

describe("Bouncer Submit Path", () => {
  it("rejects a candidate as a harness-owned preflight reject before asking the Live Agent", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn().mockResolvedValue(summary),
      preflight: vi.fn().mockResolvedValue({
        allowed: false,
        rejectReason: "mandatory-script-verify-flag-failed",
      }),
      submit: vi.fn(),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn(),
    };

    const app = buildBouncerApi({ gateNode, liveAgent });

    const response = await app.inject({
      method: "POST",
      url: "/v1/transactions",
      payload: { rawTx: "020000000001..." },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      status: "preflight_reject",
      txid: "abc123",
      reason: "mandatory-script-verify-flag-failed",
    });
    expect(liveAgent.decide).not.toHaveBeenCalled();
    expect(gateNode.submit).not.toHaveBeenCalled();
  });

  it("asks the Live Agent with a compact preflight-backed summary and submits pass decisions", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn().mockResolvedValue(summary),
      preflight: vi.fn().mockResolvedValue({
        allowed: true,
        feeRateSatVb: 0.4,
      }),
      submit: vi.fn().mockResolvedValue({ txid: "abc123" }),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn().mockResolvedValue({ action: "pass" }),
    };

    const app = buildBouncerApi({ gateNode, liveAgent });

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
    expect(liveAgent.decide).toHaveBeenCalledWith({
      rawTx: "020000000001...",
      summary,
      preflight: {
        allowed: true,
        feeRateSatVb: 0.4,
      },
    });
    expect(gateNode.submit).toHaveBeenCalledWith("020000000001...");
  });

  it("submits tag decisions to the Gate Node and returns the audit label", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn().mockResolvedValue(summary),
      preflight: vi.fn().mockResolvedValue({
        allowed: true,
        feeRateSatVb: 0.4,
      }),
      submit: vi.fn().mockResolvedValue({ txid: "abc123" }),
    };
    const liveAgent: LiveAgent = {
      decide: vi
        .fn()
        .mockResolvedValue({ action: "tag", label: "low-fee-normal" }),
    };
    const stateStore: Partial<BouncerStateStore> = {
      recordTag: vi.fn(),
      hold: vi.fn(),
      shadowDrop: vi.fn(),
    };

    const app = buildBouncerApi({ gateNode, liveAgent, stateStore });

    const response = await app.inject({
      method: "POST",
      url: "/v1/transactions",
      payload: { rawTx: "020000000001..." },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "submitted",
      txid: "abc123",
      action: "tag",
      label: "low-fee-normal",
    });
    expect(gateNode.submit).toHaveBeenCalledWith("020000000001...");
    expect(stateStore.recordTag).toHaveBeenCalledWith({
      txid: "abc123",
      label: "low-fee-normal",
      summary,
    });
  });

  it("withholds honest drop decisions and returns a Bouncer-specific rejection", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn().mockResolvedValue(summary),
      preflight: vi.fn().mockResolvedValue({
        allowed: true,
        feeRateSatVb: 0.4,
      }),
      submit: vi.fn(),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn().mockResolvedValue({
        action: "drop",
        reason: "low-fee data-like transaction shape",
      }),
    };

    const app = buildBouncerApi({ gateNode, liveAgent });

    const response = await app.inject({
      method: "POST",
      url: "/v1/transactions",
      payload: { rawTx: "020000000001..." },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      status: "dropped",
      txid: "abc123",
      reason: "low-fee data-like transaction shape",
    });
    expect(gateNode.submit).not.toHaveBeenCalled();
  });

  it("stores hold decisions in the Hold Queue and returns a pending response", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn().mockResolvedValue(summary),
      preflight: vi.fn().mockResolvedValue({
        allowed: true,
        feeRateSatVb: 0.4,
      }),
      submit: vi.fn(),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn().mockResolvedValue({
        action: "hold",
        reason: "unusual script path; operator review",
      }),
    };
    const stateStore: Partial<BouncerStateStore> = {
      recordTag: vi.fn(),
      hold: vi.fn().mockResolvedValue({ holdId: "hold_abc123" }),
      shadowDrop: vi.fn(),
    };

    const app = buildBouncerApi({ gateNode, liveAgent, stateStore });

    const response = await app.inject({
      method: "POST",
      url: "/v1/transactions",
      payload: { rawTx: "020000000001..." },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      status: "held",
      txid: "abc123",
      holdId: "hold_abc123",
      reason: "unusual script path; operator review",
    });
    expect(stateStore.hold).toHaveBeenCalledWith({
      rawTx: "020000000001...",
      txid: "abc123",
      reason: "unusual script path; operator review",
      summary,
    });
    expect(gateNode.submit).not.toHaveBeenCalled();
  });

  it("stores shadow drop decisions in the Shadow Realm while returning a success-shaped response", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn().mockResolvedValue(summary),
      preflight: vi.fn().mockResolvedValue({
        allowed: true,
        feeRateSatVb: 0.4,
      }),
      submit: vi.fn(),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn().mockResolvedValue({
        action: "shadow_drop",
        reason: "returned txid; withheld from gate node",
      }),
    };
    const stateStore: Partial<BouncerStateStore> = {
      recordTag: vi.fn(),
      hold: vi.fn(),
      shadowDrop: vi.fn(),
    };

    const app = buildBouncerApi({ gateNode, liveAgent, stateStore });

    const response = await app.inject({
      method: "POST",
      url: "/v1/transactions",
      payload: { rawTx: "020000000001..." },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      txid: "abc123",
    });
    expect(stateStore.shadowDrop).toHaveBeenCalledWith({
      rawTx: "020000000001...",
      txid: "abc123",
      reason: "returned txid; withheld from gate node",
      summary,
    });
    expect(gateNode.submit).not.toHaveBeenCalled();
  });

  it("returns the prior outcome for duplicate submissions without deciding again", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn().mockResolvedValue(summary),
      preflight: vi.fn(),
      submit: vi.fn(),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn(),
    };
    const stateStore: BouncerStateStore = {
      findIdempotencyRecord: vi.fn().mockResolvedValue({
        httpStatus: 200,
        responseBody: { txid: "abc123" },
      }),
      rememberIdempotencyRecord: vi.fn(),
      recordAuditEvent: vi.fn(),
      recordTag: vi.fn(),
      hold: vi.fn(),
      shadowDrop: vi.fn(),
      reset: vi.fn(),
    };

    const app = buildBouncerApi({ gateNode, liveAgent, stateStore });

    const response = await app.inject({
      method: "POST",
      url: "/v1/transactions",
      payload: { rawTx: "020000000001..." },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ txid: "abc123" });
    expect(stateStore.findIdempotencyRecord).toHaveBeenCalledWith("abc123");
    expect(gateNode.preflight).not.toHaveBeenCalled();
    expect(liveAgent.decide).not.toHaveBeenCalled();
    expect(stateStore.shadowDrop).not.toHaveBeenCalled();
    expect(stateStore.rememberIdempotencyRecord).not.toHaveBeenCalled();
  });

  it("remembers a fresh submitter-facing outcome as an Idempotency Record", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn().mockResolvedValue(summary),
      preflight: vi.fn().mockResolvedValue({
        allowed: true,
        feeRateSatVb: 0.4,
      }),
      submit: vi.fn().mockResolvedValue({ txid: "abc123" }),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn().mockResolvedValue({ action: "pass" }),
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

    const app = buildBouncerApi({ gateNode, liveAgent, stateStore });

    await app.inject({
      method: "POST",
      url: "/v1/transactions",
      payload: { rawTx: "020000000001..." },
    });

    expect(stateStore.rememberIdempotencyRecord).toHaveBeenCalledWith({
      txid: "abc123",
      httpStatus: 200,
      responseBody: {
        status: "submitted",
        txid: "abc123",
        action: "pass",
      },
    });
  });

  it("records a truthful audit event for the applied outcome", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn().mockResolvedValue(summary),
      preflight: vi.fn().mockResolvedValue({
        allowed: true,
        feeRateSatVb: 0.4,
      }),
      submit: vi.fn(),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn().mockResolvedValue({
        action: "shadow_drop",
        reason: "returned txid; withheld from gate node",
      }),
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

    const app = buildBouncerApi({ gateNode, liveAgent, stateStore });

    await app.inject({
      method: "POST",
      url: "/v1/transactions",
      payload: { rawTx: "020000000001..." },
    });

    expect(stateStore.recordAuditEvent).toHaveBeenCalledWith({
      txid: "abc123",
      outcome: "shadow_drop",
      responseBody: { txid: "abc123" },
    });
  });
});

describe("Bouncer State Reset", () => {
  it("clears the current Polar run state through the Bouncer API", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn(),
      preflight: vi.fn(),
      submit: vi.fn(),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn(),
    };
    const stateStore: BouncerStateStore = {
      findIdempotencyRecord: vi.fn(),
      rememberIdempotencyRecord: vi.fn(),
      recordAuditEvent: vi.fn(),
      recordTag: vi.fn(),
      hold: vi.fn(),
      shadowDrop: vi.fn(),
      reset: vi.fn(),
    };

    const app = buildBouncerApi({ gateNode, liveAgent, stateStore });

    const response = await app.inject({
      method: "POST",
      url: "/v1/state/reset",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "reset" });
    expect(stateStore.reset).toHaveBeenCalledOnce();
  });
});
