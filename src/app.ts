import Fastify from "fastify";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import type {
  AgentAction,
  BouncerStateStore,
  GateNode,
  LiveAgent,
  PreflightCheck,
  TxSummary,
} from "./domain.js";

const submitCandidateSchema = z.object({
  rawTx: z.string().min(1),
});

type RuntimeMetadata = {
  promptHash: string;
  gateNodeName: string;
  propagationWitnessNames: string[];
};

type SubmitContext = {
  rawTx: string;
  summary: TxSummary;
  preflight: PreflightCheck & { allowed: true };
};

export function buildBouncerApi(dependencies: {
  gateNode: GateNode;
  liveAgent: LiveAgent;
  stateStore?: Partial<BouncerStateStore>;
  runtime?: RuntimeMetadata;
  decisionQueue?: {
    maxPending: number;
  };
}) {
  const app = Fastify();
  const stateStore: BouncerStateStore = {
    ...createNoopStateStore(),
    ...dependencies.stateStore,
  };
  const decisionQueue = new DecisionQueue(
    dependencies.decisionQueue?.maxPending ?? Number.POSITIVE_INFINITY,
  );

  app.get("/v1/health", async () => {
    return {
      status: "ready",
      promptHash: dependencies.runtime?.promptHash,
      gateNode: dependencies.runtime?.gateNodeName,
      propagationWitnesses: dependencies.runtime?.propagationWitnessNames ?? [],
    };
  });

  app.post("/submit", async (request, reply) =>
    submitCandidate({ requestBody: request.body, reply }),
  );
  app.post("/v1/transactions", async (request, reply) =>
    submitCandidate({ requestBody: request.body, reply }),
  );

  app.get("/v1/audit", async (request) => {
    const query = request.query as {
      txid?: string;
      outcome?: string;
    };
    const events = await stateStore.findAuditEvents?.({
      txid: query.txid,
      outcome: query.outcome,
    });

    return { events: events ?? [] };
  });

  app.get("/v1/holds", async () => {
    const holds = await stateStore.listHolds?.();
    return { holds: holds ?? [] };
  });

  app.get("/v1/holds/:holdId", async (request, reply) => {
    const { holdId } = request.params as { holdId: string };
    const holds = (await stateStore.listHolds?.()) ?? [];
    const hold = holds.find((entry) => entry.holdId === holdId);

    if (!hold) {
      return reply.status(404).send({
        status: "not_found",
        holdId,
      });
    }

    return { hold };
  });

  app.get("/v1/shadow-realm/:txid", async (request, reply) => {
    const { txid } = request.params as { txid: string };
    const shadowDrop = await stateStore.findShadowDrop?.(txid);

    if (!shadowDrop) {
      return reply.status(404).send({
        status: "not_found",
        txid,
      });
    }

    return { shadowDrop };
  });

  app.post("/v1/holds/:holdId/release", async (request, reply) => {
    const { holdId } = request.params as { holdId: string };
    const holds = (await stateStore.listHolds?.()) ?? [];
    const hold = holds.find((entry) => entry.holdId === holdId);

    if (!hold) {
      return reply.status(404).send({
        status: "not_found",
        holdId,
      });
    }

    const submission = await dependencies.gateNode.submit(hold.rawTx);
    await stateStore.releaseHold?.(holdId);

    return {
      status: "released",
      holdId,
      txid: submission.txid,
    };
  });

  app.post("/v1/holds/:holdId/discard", async (request) => {
    const { holdId } = request.params as { holdId: string };
    await stateStore.discardHold?.(holdId);

    return {
      status: "discarded",
      holdId,
    };
  });

  app.post("/v1/state/reset", async () => {
    await stateStore.reset();

    return {
      status: "reset",
    };
  });

  async function submitCandidate(input: {
    requestBody: unknown;
    reply: FastifyReply;
  }) {
    const parsed = submitCandidateSchema.safeParse(input.requestBody);

    if (!parsed.success) {
      return input.reply.status(400).send({
        status: "bad_request",
        reason: "rawTx is required",
      });
    }

    const { rawTx } = parsed.data;
    let summary: TxSummary;

    try {
      summary = await dependencies.gateNode.summarize(rawTx);
    } catch (error) {
      return input.reply.status(400).send({
        status: "parse_failure",
        reason: errorMessage(error),
      });
    }

    const priorOutcome = await stateStore.findIdempotencyRecord(summary.txid);

    if (priorOutcome) {
      return input.reply
        .status(priorOutcome.httpStatus)
        .send(priorOutcome.responseBody);
    }

    if (!decisionQueue.tryAdmit()) {
      return submitQueueFullPass({
        reply: input.reply,
        rawTx,
        summary,
      });
    }

    try {
      return await processQueuedSubmit({
        reply: input.reply,
        rawTx,
        summary,
      });
    } finally {
      decisionQueue.complete();
    }
  }

  async function processQueuedSubmit(input: {
    reply: FastifyReply;
    rawTx: string;
    summary: TxSummary;
  }) {
    const preflight = await dependencies.gateNode.preflight(input.rawTx);

    if (!preflight.allowed) {
      return sendRememberedOutcome({
        reply: input.reply,
        stateStore,
        runtime: dependencies.runtime,
        txid: input.summary.txid,
        outcome: "preflight_reject",
        httpStatus: 422,
        responseBody: {
          status: "preflight_reject",
          txid: input.summary.txid,
          reason: preflight.rejectReason,
        },
      });
    }

    const context = {
      rawTx: input.rawTx,
      summary: input.summary,
      preflight,
    };
    const agentAction = await dependencies.liveAgent.decide(context);

    return applyAgentAction({
      reply: input.reply,
      context,
      agentAction,
    });
  }

  async function applyAgentAction(input: {
    reply: FastifyReply;
    context: SubmitContext;
    agentAction: AgentAction;
  }) {
    const { rawTx, summary } = input.context;

    if (input.agentAction.action === "pass") {
      return submitAllowedTransaction({
        reply: input.reply,
        rawTx,
        txid: summary.txid,
        action: "pass",
        liveAgentFallbackReason: input.agentAction.reason?.startsWith(
          "live_agent_fallback:",
        )
          ? input.agentAction.reason
          : undefined,
      });
    }

    if (input.agentAction.action === "tag") {
      return submitTaggedTransaction({
        reply: input.reply,
        rawTx,
        summary,
        label: input.agentAction.label,
      });
    }

    if (input.agentAction.action === "drop") {
      return sendRememberedOutcome({
        reply: input.reply,
        stateStore,
        runtime: dependencies.runtime,
        txid: summary.txid,
        outcome: "drop",
        httpStatus: 403,
        responseBody: {
          status: "dropped",
          txid: summary.txid,
          reason: input.agentAction.reason,
        },
      });
    }

    if (input.agentAction.action === "hold") {
      try {
        const hold = await stateStore.hold({
          rawTx,
          txid: summary.txid,
          reason: input.agentAction.reason,
          summary,
        });

        return sendRememberedOutcome({
          reply: input.reply,
          stateStore,
          runtime: dependencies.runtime,
          txid: summary.txid,
          outcome: "hold",
          httpStatus: 202,
          responseBody: {
            status: "held",
            txid: summary.txid,
            holdId: hold.holdId,
            reason: input.agentAction.reason,
          },
        });
      } catch (error) {
        if (!isHoldQueueFull(error)) {
          throw error;
        }

        return submitAllowedTransaction({
          reply: input.reply,
          rawTx,
          txid: summary.txid,
          action: "hold_queue_full_pass",
        });
      }
    }

    if (input.agentAction.action === "shadow_drop") {
      let storageError: string | undefined;

      try {
        await stateStore.shadowDrop({
          rawTx,
          txid: summary.txid,
          reason: input.agentAction.reason,
          summary,
        });
      } catch (error) {
        storageError = errorMessage(error);
      }

      return sendShadowDropOutcome({
        reply: input.reply,
        stateStore,
        runtime: dependencies.runtime,
        txid: summary.txid,
        storageError,
      });
    }

    assertNever(input.agentAction);
  }

  async function submitQueueFullPass(input: {
    reply: FastifyReply;
    rawTx: string;
    summary: TxSummary;
  }) {
    const submission = await dependencies.gateNode.submit(input.rawTx);

    return sendRememberedOutcome({
      reply: input.reply,
      stateStore,
      runtime: dependencies.runtime,
      txid: submission.txid,
      outcome: "queue_full_pass",
      httpStatus: 200,
      responseBody: {
        status: "submitted",
        txid: submission.txid,
        action: "queue_full_pass",
      },
    });
  }

  async function submitAllowedTransaction(input: {
    reply: FastifyReply;
    rawTx: string;
    txid: string;
    action: "pass" | "tag" | "hold_queue_full_pass";
    label?: string;
    liveAgentFallbackReason?: string;
  }) {
    try {
      const submission = await dependencies.gateNode.submit(input.rawTx);
      const responseBody = {
        status: "submitted",
        txid: submission.txid,
        action: input.action,
        ...(input.label ? { label: input.label } : {}),
      };

      return sendRememberedOutcome({
        reply: input.reply,
        stateStore,
        runtime: dependencies.runtime,
        txid: submission.txid,
        outcome: input.action,
        httpStatus: 200,
        responseBody,
        auditResponseBody: input.liveAgentFallbackReason
          ? {
              ...responseBody,
              internal: {
                liveAgentFallback: input.liveAgentFallbackReason,
              },
            }
          : undefined,
      });
    } catch (error) {
      return sendRememberedOutcome({
        reply: input.reply,
        stateStore,
        runtime: dependencies.runtime,
        txid: input.txid,
        outcome: "gate_submission_failure",
        httpStatus: 502,
        responseBody: {
          status: "gate_submission_failure",
          txid: input.txid,
          action: input.action,
          reason: errorMessage(error),
        },
      });
    }
  }

  async function submitTaggedTransaction(input: {
    reply: FastifyReply;
    rawTx: string;
    summary: TxSummary;
    label: string;
  }) {
    try {
      const submission = await dependencies.gateNode.submit(input.rawTx);

      return sendRememberedOutcome({
        reply: input.reply,
        stateStore,
        runtime: dependencies.runtime,
        txid: submission.txid,
        outcome: "tag",
        httpStatus: 200,
        responseBody: {
          status: "submitted",
          txid: submission.txid,
          action: "tag",
          label: input.label,
        },
        afterRemember: async () => {
          await stateStore.recordTag({
            txid: submission.txid,
            label: input.label,
            summary: input.summary,
          });
        },
      });
    } catch (error) {
      return sendRememberedOutcome({
        reply: input.reply,
        stateStore,
        runtime: dependencies.runtime,
        txid: input.summary.txid,
        outcome: "gate_submission_failure",
        httpStatus: 502,
        responseBody: {
          status: "gate_submission_failure",
          txid: input.summary.txid,
          action: "tag",
          reason: errorMessage(error),
        },
      });
    }
  }

  return app;
}

class DecisionQueue {
  readonly #maxPending: number;
  #pending = 0;

  constructor(maxPending: number) {
    this.#maxPending = maxPending;
  }

  tryAdmit(): boolean {
    if (this.#pending >= this.#maxPending) {
      return false;
    }

    this.#pending += 1;
    return true;
  }

  complete() {
    this.#pending = Math.max(0, this.#pending - 1);
  }
}

function createNoopStateStore(): BouncerStateStore {
  return {
    findIdempotencyRecord() {
      return undefined;
    },
    rememberIdempotencyRecord() {},
    recordAuditEvent() {},
    recordTag() {},
    hold() {
      return { holdId: "hold-untracked" };
    },
    async listHolds() {
      return [];
    },
    async releaseHold() {},
    async discardHold() {},
    shadowDrop() {},
    reset() {},
  };
}

async function sendRememberedOutcome(input: {
  reply: FastifyReply;
  stateStore: BouncerStateStore;
  runtime?: {
    promptHash: string;
  };
  txid: string;
  outcome: string;
  httpStatus: number;
  responseBody: unknown;
  auditResponseBody?: unknown;
  afterRemember?: () => Promise<void> | void;
}) {
  await input.stateStore.recordAuditEvent({
    txid: input.txid,
    outcome: input.outcome,
    responseBody: input.auditResponseBody ?? input.responseBody,
    promptHash: input.runtime?.promptHash,
  });
  await input.stateStore.rememberIdempotencyRecord({
    txid: input.txid,
    httpStatus: input.httpStatus,
    responseBody: input.responseBody,
  });
  await input.afterRemember?.();

  return input.reply.status(input.httpStatus).send(input.responseBody);
}

async function sendShadowDropOutcome(input: {
  reply: FastifyReply;
  stateStore: BouncerStateStore;
  runtime?: {
    promptHash: string;
  };
  txid: string;
  storageError?: string;
}) {
  const submitterResponse = { txid: input.txid };
  const auditResponse = input.storageError
    ? {
        txid: input.txid,
        internal: {
          shadowRealmStorage: "degraded",
          storageError: input.storageError,
        },
      }
    : submitterResponse;

  await input.stateStore.recordAuditEvent({
    txid: input.txid,
    outcome: "shadow_drop",
    responseBody: auditResponse,
    promptHash: input.runtime?.promptHash,
  });
  await input.stateStore.rememberIdempotencyRecord({
    txid: input.txid,
    httpStatus: 200,
    responseBody: submitterResponse,
  });

  return input.reply.status(200).send(submitterResponse);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isHoldQueueFull(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "HoldQueueFullError" ||
      error.message.toLowerCase().includes("hold queue full"))
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Agent Action: ${JSON.stringify(value)}`);
}
