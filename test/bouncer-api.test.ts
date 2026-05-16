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

describe.concurrent("Bouncer Submit Path", () => {
  it("accepts candidate raw transactions through /submit", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn().mockResolvedValue(summary),
      preflight: vi.fn().mockResolvedValue({ allowed: true }),
      submit: vi.fn().mockResolvedValue({ txid: "abc123" }),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn().mockResolvedValue({ action: "pass" }),
    };

    const app = buildBouncerApi({ gateNode, liveAgent });

    const response = await app.inject({
      method: "POST",
      url: "/submit",
      payload: { rawTx: "020000000001..." },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "submitted",
      txid: "abc123",
      action: "pass",
    });
  });

  it("handles parse failures separately from Live Agent judgment", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn().mockRejectedValue(new Error("TX decode failed")),
      preflight: vi.fn(),
      submit: vi.fn(),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn(),
    };

    const app = buildBouncerApi({ gateNode, liveAgent });

    const response = await app.inject({
      method: "POST",
      url: "/submit",
      payload: { rawTx: "not-a-raw-transaction" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      status: "parse_failure",
      reason: "TX decode failed",
    });
    expect(gateNode.preflight).not.toHaveBeenCalled();
    expect(liveAgent.decide).not.toHaveBeenCalled();
  });

  it("fails open with a queue-full pass override before preflight or Live Agent work", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn().mockResolvedValue(summary),
      preflight: vi.fn(),
      submit: vi.fn().mockResolvedValue({ txid: "abc123" }),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn(),
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
      liveAgent,
      stateStore,
      decisionQueue: { maxPending: 0 },
    });

    const response = await app.inject({
      method: "POST",
      url: "/submit",
      payload: { rawTx: "020000000001..." },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "submitted",
      txid: "abc123",
      action: "queue_full_pass",
    });
    expect(gateNode.preflight).not.toHaveBeenCalled();
    expect(liveAgent.decide).not.toHaveBeenCalled();
    expect(stateStore.recordAuditEvent).toHaveBeenCalledWith({
      txid: "abc123",
      outcome: "queue_full_pass",
      responseBody: {
        status: "submitted",
        txid: "abc123",
        action: "queue_full_pass",
      },
      promptHash: undefined,
    });
  });

  it("records Gate Submission Failure without rewriting the pass decision", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn().mockResolvedValue(summary),
      preflight: vi.fn().mockResolvedValue({ allowed: true }),
      submit: vi.fn().mockRejectedValue(new Error("min relay fee not met")),
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

    const response = await app.inject({
      method: "POST",
      url: "/submit",
      payload: { rawTx: "020000000001..." },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      status: "gate_submission_failure",
      txid: "abc123",
      action: "pass",
      reason: "min relay fee not met",
    });
    expect(stateStore.recordAuditEvent).toHaveBeenCalledWith({
      txid: "abc123",
      outcome: "gate_submission_failure",
      responseBody: {
        status: "gate_submission_failure",
        txid: "abc123",
        action: "pass",
        reason: "min relay fee not met",
      },
      promptHash: undefined,
    });
  });

  it("does not record a tag label when tag submission fails at the Gate Node", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn().mockResolvedValue(summary),
      preflight: vi.fn().mockResolvedValue({ allowed: true }),
      submit: vi.fn().mockRejectedValue(new Error("txn-mempool-conflict")),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn().mockResolvedValue({
        action: "tag",
        label: "low-fee-normal",
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

    const response = await app.inject({
      method: "POST",
      url: "/submit",
      payload: { rawTx: "020000000001..." },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      status: "gate_submission_failure",
      txid: "abc123",
      action: "tag",
      reason: "txn-mempool-conflict",
    });
    expect(stateStore.recordTag).not.toHaveBeenCalled();
  });

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

  it("audits Live Agent fallback pass overrides without exposing them to submitters", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn().mockResolvedValue(summary),
      preflight: vi.fn().mockResolvedValue({ allowed: true }),
      submit: vi.fn().mockResolvedValue({ txid: "abc123" }),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn().mockResolvedValue({
        action: "pass",
        reason: "live_agent_fallback: malformed_action",
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

    const response = await app.inject({
      method: "POST",
      url: "/submit",
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
      promptHash: undefined,
    });
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

    const app = buildBouncerApi({
      gateNode,
      liveAgent,
      stateStore,
      runtime: {
        promptHash:
          "sha256:797802292fafe4572517110ae2c3cc89a67d5fac52369f4aef091a08479ea205",
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

    const app = buildBouncerApi({
      gateNode,
      liveAgent,
      stateStore,
      runtime: {
        promptHash:
          "sha256:797802292fafe4572517110ae2c3cc89a67d5fac52369f4aef091a08479ea205",
        gateNodeName: "backend1",
        propagationWitnessNames: [],
      },
    });

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

  it("falls back to pass with an audit override when the Hold Queue is full", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn().mockResolvedValue(summary),
      preflight: vi.fn().mockResolvedValue({ allowed: true }),
      submit: vi.fn().mockResolvedValue({ txid: "abc123" }),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn().mockResolvedValue({
        action: "hold",
        reason: "operator review",
      }),
    };
    const stateStore: BouncerStateStore = {
      findIdempotencyRecord: vi.fn().mockResolvedValue(undefined),
      rememberIdempotencyRecord: vi.fn(),
      recordAuditEvent: vi.fn(),
      recordTag: vi.fn(),
      hold: vi.fn().mockRejectedValue(new Error("Hold Queue full")),
      shadowDrop: vi.fn(),
      reset: vi.fn(),
    };

    const app = buildBouncerApi({ gateNode, liveAgent, stateStore });

    const response = await app.inject({
      method: "POST",
      url: "/submit",
      payload: { rawTx: "020000000001..." },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "submitted",
      txid: "abc123",
      action: "hold_queue_full_pass",
    });
    expect(gateNode.submit).toHaveBeenCalledWith("020000000001...");
    expect(stateStore.recordAuditEvent).toHaveBeenCalledWith({
      txid: "abc123",
      outcome: "hold_queue_full_pass",
      responseBody: {
        status: "submitted",
        txid: "abc123",
        action: "hold_queue_full_pass",
      },
      promptHash: undefined,
    });
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

  it("audits degraded Shadow Realm storage while still applying shadow drop", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn().mockResolvedValue(summary),
      preflight: vi.fn().mockResolvedValue({ allowed: true }),
      submit: vi.fn(),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn().mockResolvedValue({
        action: "shadow_drop",
        reason: "withhold but return txid",
      }),
    };
    const stateStore: BouncerStateStore = {
      findIdempotencyRecord: vi.fn().mockResolvedValue(undefined),
      rememberIdempotencyRecord: vi.fn(),
      recordAuditEvent: vi.fn(),
      recordTag: vi.fn(),
      hold: vi.fn(),
      shadowDrop: vi.fn().mockRejectedValue(new Error("disk full")),
      reset: vi.fn(),
    };

    const app = buildBouncerApi({ gateNode, liveAgent, stateStore });

    const response = await app.inject({
      method: "POST",
      url: "/submit",
      payload: { rawTx: "020000000001..." },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ txid: "abc123" });
    expect(gateNode.submit).not.toHaveBeenCalled();
    expect(stateStore.recordAuditEvent).toHaveBeenCalledWith({
      txid: "abc123",
      outcome: "shadow_drop",
      responseBody: {
        txid: "abc123",
        internal: {
          shadowRealmStorage: "degraded",
          storageError: "disk full",
        },
      },
      promptHash: undefined,
    });
    expect(stateStore.rememberIdempotencyRecord).toHaveBeenCalledWith({
      txid: "abc123",
      httpStatus: 200,
      responseBody: { txid: "abc123" },
    });
  });

  it("lets operators inspect Shadow Realm records without exposing them to submitters", async () => {
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
      findShadowDrop: vi.fn().mockResolvedValue({
        txid: "abc123",
        reason: "withhold but return txid",
        rawTx: "020000000001...",
        summary,
      }),
      reset: vi.fn(),
    };

    const app = buildBouncerApi({ gateNode, liveAgent, stateStore });

    const response = await app.inject({
      method: "GET",
      url: "/v1/shadow-realm/abc123",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      shadowDrop: {
        txid: "abc123",
        reason: "withhold but return txid",
        rawTx: "020000000001...",
        summary,
      },
    });
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

    const app = buildBouncerApi({
      gateNode,
      liveAgent,
      stateStore,
      runtime: {
        promptHash:
          "sha256:797802292fafe4572517110ae2c3cc89a67d5fac52369f4aef091a08479ea205",
        gateNodeName: "backend1",
        propagationWitnessNames: [],
      },
    });

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

    const app = buildBouncerApi({
      gateNode,
      liveAgent,
      stateStore,
      runtime: {
        promptHash:
          "sha256:797802292fafe4572517110ae2c3cc89a67d5fac52369f4aef091a08479ea205",
        gateNodeName: "backend1",
        propagationWitnessNames: [],
      },
    });

    await app.inject({
      method: "POST",
      url: "/v1/transactions",
      payload: { rawTx: "020000000001..." },
    });

    expect(stateStore.recordAuditEvent).toHaveBeenCalledWith({
      txid: "abc123",
      outcome: "shadow_drop",
      responseBody: { txid: "abc123" },
      promptHash:
        "sha256:797802292fafe4572517110ae2c3cc89a67d5fac52369f4aef091a08479ea205",
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

describe("Bouncer Audit Status", () => {
  it("returns audit events filtered by txid and outcome", async () => {
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
      findAuditEvents: vi.fn().mockResolvedValue([
        {
          txid: "abc123",
          outcome: "shadow_drop",
          responseBody: { txid: "abc123" },
          promptHash:
            "sha256:797802292fafe4572517110ae2c3cc89a67d5fac52369f4aef091a08479ea205",
        },
      ]),
      recordTag: vi.fn(),
      hold: vi.fn(),
      shadowDrop: vi.fn(),
      reset: vi.fn(),
    };

    const app = buildBouncerApi({ gateNode, liveAgent, stateStore });

    const response = await app.inject({
      method: "GET",
      url: "/v1/audit?txid=abc123&outcome=shadow_drop",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      events: [
        {
          txid: "abc123",
          outcome: "shadow_drop",
          responseBody: { txid: "abc123" },
          promptHash:
            "sha256:797802292fafe4572517110ae2c3cc89a67d5fac52369f4aef091a08479ea205",
        },
      ],
    });
    expect(stateStore.findAuditEvents).toHaveBeenCalledWith({
      txid: "abc123",
      outcome: "shadow_drop",
    });
  });
});

describe("Bouncer Run Events", () => {
  it("returns an empty run event list before smoke or fuzz scripts publish progress", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn(),
      preflight: vi.fn(),
      submit: vi.fn(),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn(),
    };

    const app = buildBouncerApi({ gateNode, liveAgent });

    const response = await app.inject({
      method: "GET",
      url: "/v1/demo/events",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ events: [] });
  });

  it("records smoke and fuzz run progress for the read-only demo dashboard", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn(),
      preflight: vi.fn(),
      submit: vi.fn(),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn(),
    };

    const app = buildBouncerApi({ gateNode, liveAgent });

    const publishResponse = await app.inject({
      method: "POST",
      url: "/v1/demo/events",
      payload: {
        runId: "smoke-123",
        source: "smoke",
        name: "Bouncer Runtime ready",
        status: "passed",
        detail: {
          gateNode: "backend1",
          propagationWitnesses: ["backend2", "backend3"],
        },
      },
    });
    const listResponse = await app.inject({
      method: "GET",
      url: "/v1/demo/events",
    });

    expect(publishResponse.statusCode).toBe(200);
    expect(publishResponse.json()).toMatchObject({
      event: {
        id: 1,
        runId: "smoke-123",
        source: "smoke",
        name: "Bouncer Runtime ready",
        status: "passed",
        detail: {
          gateNode: "backend1",
          propagationWitnesses: ["backend2", "backend3"],
        },
      },
    });
    expect(publishResponse.json().event.createdAt).toEqual(expect.any(String));
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual({
      events: [publishResponse.json().event],
    });
  });

  it("streams newly recorded run events for real-time dashboard logs", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn(),
      preflight: vi.fn(),
      submit: vi.fn(),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn(),
    };

    const app = buildBouncerApi({ gateNode, liveAgent });
    const streamResponse = app.inject({
      method: "GET",
      url: "/v1/demo/events/stream?once=1",
    });

    await app.inject({
      method: "POST",
      url: "/v1/demo/events",
      payload: {
        runId: "forced_actions-123",
        source: "smoke",
        name: "Forced shadow_drop observed",
        status: "passed",
        detail: {
          action: "shadow_drop",
          txid: "abc123",
          handling: "shadow-realm",
        },
      },
    });

    const response = await streamResponse;

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: run-event");
    expect(response.body).toContain("Forced shadow_drop observed");
    expect(response.body).toContain("shadow-realm");
  });

  it("clears demo run events without clearing audit state", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn(),
      preflight: vi.fn(),
      submit: vi.fn(),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn(),
    };

    const app = buildBouncerApi({ gateNode, liveAgent });

    await app.inject({
      method: "POST",
      url: "/v1/demo/events",
      payload: {
        runId: "smoke-123",
        source: "smoke",
        name: "Smoke run started",
        status: "running",
      },
    });
    const clearResponse = await app.inject({
      method: "DELETE",
      url: "/v1/demo/events",
    });
    const listResponse = await app.inject({
      method: "GET",
      url: "/v1/demo/events",
    });

    expect(clearResponse.statusCode).toBe(200);
    expect(clearResponse.json()).toEqual({ status: "cleared" });
    expect(listResponse.json()).toEqual({ events: [] });
  });

  it("starts a demo run and records it for the dashboard", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn(),
      preflight: vi.fn(),
      submit: vi.fn(),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn(),
    };
    const demoRunTrigger = vi.fn(async ({ recordEvent, runId }) => {
      await recordEvent({
        runId,
        source: "smoke",
        name: "Forced action observed",
        status: "passed",
        detail: { action: "hold" },
      });
    });

    const app = buildBouncerApi({ gateNode, liveAgent, demoRunTrigger });

    const response = await app.inject({
      method: "POST",
      url: "/v1/demo/runs",
      payload: { kind: "forced_actions" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      kind: "forced_actions",
      status: "running",
    });
    expect(demoRunTrigger).toHaveBeenCalledWith({
      kind: "forced_actions",
      runId: response.json().runId,
      recordEvent: expect.any(Function),
    });

    await vi.waitFor(async () => {
      const eventsResponse = await app.inject({
        method: "GET",
        url: "/v1/demo/events",
      });

      expect(eventsResponse.json().events).toMatchObject([
        {
          runId: response.json().runId,
          source: "smoke",
          name: "Forced-action smoke started",
          status: "running",
        },
        {
          runId: response.json().runId,
          source: "smoke",
          name: "Forced action observed",
          status: "passed",
          detail: { action: "hold" },
        },
        {
          runId: response.json().runId,
          source: "smoke",
          name: "Forced-action smoke finished",
          status: "passed",
        },
      ]);
    });
  });

  it("starts a fuzz demo run against the dashboard runtime URL", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn(),
      preflight: vi.fn(),
      submit: vi.fn(),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn(),
    };
    const demoRunTrigger = vi.fn().mockResolvedValue(undefined);

    const app = buildBouncerApi({ gateNode, liveAgent, demoRunTrigger });

    const response = await app.inject({
      method: "POST",
      url: "/v1/demo/runs",
      payload: { kind: "fuzz" },
    });

    expect(response.statusCode).toBe(202);

    await vi.waitFor(async () => {
      const eventsResponse = await app.inject({
        method: "GET",
        url: "/v1/demo/events",
      });

      expect(eventsResponse.json().events[0]).toMatchObject({
        runId: response.json().runId,
        source: "fuzz",
        name: "Fuzz run started",
        status: "running",
        detail: {
          command: "npm run fuzz:candidates",
          bouncerUrl: "http://127.0.0.1:3130",
        },
      });
    });
  });

  it("starts a model compliance run separately from deterministic forced actions", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn(),
      preflight: vi.fn(),
      submit: vi.fn(),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn(),
    };
    const demoRunTrigger = vi.fn().mockResolvedValue(undefined);

    const app = buildBouncerApi({ gateNode, liveAgent, demoRunTrigger });

    const response = await app.inject({
      method: "POST",
      url: "/v1/demo/runs",
      payload: { kind: "model_compliance" },
    });

    expect(response.statusCode).toBe(202);
    expect(demoRunTrigger).toHaveBeenCalledWith({
      kind: "model_compliance",
      runId: response.json().runId,
      recordEvent: expect.any(Function),
    });

    await vi.waitFor(async () => {
      const eventsResponse = await app.inject({
        method: "GET",
        url: "/v1/demo/events",
      });

      expect(eventsResponse.json().events[0]).toMatchObject({
        runId: response.json().runId,
        source: "smoke",
        name: "Model compliance smoke started",
        status: "running",
        detail: {
          command: "npm run smoke:polar:model-compliance",
        },
      });
    });
  });

  it("rejects a second demo run while one is active", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn(),
      preflight: vi.fn(),
      submit: vi.fn(),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn(),
    };
    let finishRun: () => void = () => {};
    const demoRunTrigger = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRun = resolve;
        }),
    );

    const app = buildBouncerApi({ gateNode, liveAgent, demoRunTrigger });

    const firstResponse = await app.inject({
      method: "POST",
      url: "/v1/demo/runs",
      payload: { kind: "smoke" },
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/v1/demo/runs",
      payload: { kind: "fuzz" },
    });

    expect(firstResponse.statusCode).toBe(202);
    expect(secondResponse.statusCode).toBe(409);
    expect(secondResponse.json()).toMatchObject({
      status: "run_already_active",
      runId: firstResponse.json().runId,
    });

    finishRun();
  });
});

describe("Hold Queue Operator Flow", () => {
  it("lets operators list, release, and discard held transactions", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn(),
      preflight: vi.fn(),
      submit: vi.fn().mockResolvedValue({ txid: "abc123" }),
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
      listHolds: vi.fn().mockResolvedValue([
        {
          holdId: "hold_abc123",
          txid: "abc123",
          status: "held",
          reason: "operator review",
          rawTx: "020000000001...",
          summary,
        },
      ]),
      releaseHold: vi.fn(),
      discardHold: vi.fn(),
      shadowDrop: vi.fn(),
      reset: vi.fn(),
    };

    const app = buildBouncerApi({ gateNode, liveAgent, stateStore });

    const listResponse = await app.inject({
      method: "GET",
      url: "/v1/holds",
    });
    const inspectResponse = await app.inject({
      method: "GET",
      url: "/v1/holds/hold_abc123",
    });
    const releaseResponse = await app.inject({
      method: "POST",
      url: "/v1/holds/hold_abc123/release",
    });
    const discardResponse = await app.inject({
      method: "POST",
      url: "/v1/holds/hold_def456/discard",
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual({
      holds: [
        {
          holdId: "hold_abc123",
          txid: "abc123",
          status: "held",
          reason: "operator review",
          rawTx: "020000000001...",
          summary,
        },
      ],
    });
    expect(inspectResponse.statusCode).toBe(200);
    expect(inspectResponse.json()).toEqual({
      hold: {
        holdId: "hold_abc123",
        txid: "abc123",
        status: "held",
        reason: "operator review",
        rawTx: "020000000001...",
        summary,
      },
    });
    expect(releaseResponse.statusCode).toBe(200);
    expect(releaseResponse.json()).toEqual({
      status: "released",
      holdId: "hold_abc123",
      txid: "abc123",
    });
    expect(discardResponse.statusCode).toBe(200);
    expect(discardResponse.json()).toEqual({
      status: "discarded",
      holdId: "hold_def456",
    });
    expect(gateNode.submit).toHaveBeenCalledWith("020000000001...");
    expect(stateStore.releaseHold).toHaveBeenCalledWith("hold_abc123");
    expect(stateStore.discardHold).toHaveBeenCalledWith("hold_def456");
  });
});

describe("Bouncer Runtime Health", () => {
  it("reports readiness, active prompt, prompt hash, and configured node names without leaking secrets", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn(),
      preflight: vi.fn(),
      submit: vi.fn(),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn(),
    };

    const app = buildBouncerApi({
      gateNode,
      liveAgent,
      runtime: {
        prompt: "Prefer pass unless the smoke directive asks for a different result.",
        promptHash:
          "sha256:797802292fafe4572517110ae2c3cc89a67d5fac52369f4aef091a08479ea205",
        gateNodeName: "backend1",
        propagationWitnessNames: ["backend2", "backend3"],
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      prompt: "Prefer pass unless the smoke directive asks for a different result.",
      promptHash:
        "sha256:797802292fafe4572517110ae2c3cc89a67d5fac52369f4aef091a08479ea205",
      gateNode: "backend1",
      propagationWitnesses: ["backend2", "backend3"],
    });
    expect(response.body).not.toContain("polarpass");
    expect(response.body).not.toContain("polaruser");
    expect(response.body).not.toContain("http://127.0.0.1:18443");
  });

  it("saves and activates an edited Bouncer Prompt immediately", async () => {
    const gateNode: GateNode = {
      summarize: vi.fn(),
      preflight: vi.fn(),
      submit: vi.fn(),
    };
    const liveAgent: LiveAgent = {
      decide: vi.fn(),
    };
    const savePrompt = vi.fn().mockResolvedValue({
      prompt: "Prefer hold when the candidate looks weird.\n",
      promptHash:
        "sha256:c14e36e0137bb173a998835191ccbc0b3cbee3fc17bb7755db26fa92ac798d5c",
    });

    const app = buildBouncerApi({
      gateNode,
      liveAgent,
      runtime: {
        prompt: "Prefer pass unless the smoke directive asks for a different result.",
        promptHash:
          "sha256:797802292fafe4572517110ae2c3cc89a67d5fac52369f4aef091a08479ea205",
        gateNodeName: "backend1",
        propagationWitnessNames: ["backend2", "backend3"],
      },
      savePrompt,
    });

    const response = await app.inject({
      method: "PUT",
      url: "/v1/prompt",
      payload: { prompt: "Prefer hold when the candidate looks weird.\n" },
    });
    const healthResponse = await app.inject({
      method: "GET",
      url: "/v1/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "saved",
      prompt: "Prefer hold when the candidate looks weird.\n",
      promptHash:
        "sha256:c14e36e0137bb173a998835191ccbc0b3cbee3fc17bb7755db26fa92ac798d5c",
      activePromptHash:
        "sha256:c14e36e0137bb173a998835191ccbc0b3cbee3fc17bb7755db26fa92ac798d5c",
      requiresRestart: false,
    });
    expect(healthResponse.json()).toMatchObject({
      prompt: "Prefer hold when the candidate looks weird.\n",
      promptHash:
        "sha256:c14e36e0137bb173a998835191ccbc0b3cbee3fc17bb7755db26fa92ac798d5c",
    });
    expect(savePrompt).toHaveBeenCalledWith(
      "Prefer hold when the candidate looks weird.\n",
    );
  });
});
