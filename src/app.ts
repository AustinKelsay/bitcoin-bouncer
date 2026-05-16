import Fastify from "fastify";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import type { BouncerStateStore, GateNode, LiveAgent } from "./domain.js";

const submitCandidateSchema = z.object({
  rawTx: z.string().min(1),
});

export function buildBouncerApi(dependencies: {
  gateNode: GateNode;
  liveAgent: LiveAgent;
  stateStore?: Partial<BouncerStateStore>;
}) {
  const app = Fastify();
  const stateStore = {
    ...createNoopStateStore(),
    ...dependencies.stateStore,
  };

  app.post("/v1/transactions", async (request, reply) => {
    const parsed = submitCandidateSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        status: "bad_request",
        reason: "rawTx is required",
      });
    }

    const { rawTx } = parsed.data;
    const summary = await dependencies.gateNode.summarize(rawTx);
    const priorOutcome = await stateStore.findIdempotencyRecord(summary.txid);

    if (priorOutcome) {
      return reply.status(priorOutcome.httpStatus).send(priorOutcome.responseBody);
    }

    const preflight = await dependencies.gateNode.preflight(rawTx);

    if (!preflight.allowed) {
      return sendRememberedOutcome({
        reply,
        stateStore,
        txid: summary.txid,
        outcome: "preflight_reject",
        httpStatus: 422,
        responseBody: {
        status: "preflight_reject",
        txid: summary.txid,
        reason: preflight.rejectReason,
        },
      });
    }

    const agentAction = await dependencies.liveAgent.decide({
      rawTx,
      summary,
      preflight,
    });

    if (agentAction.action === "pass") {
      const submission = await dependencies.gateNode.submit(rawTx);

      return sendRememberedOutcome({
        reply,
        stateStore,
        txid: submission.txid,
        outcome: "pass",
        httpStatus: 200,
        responseBody: {
        status: "submitted",
        txid: submission.txid,
        action: "pass",
        },
      });
    }

    if (agentAction.action === "tag") {
      const submission = await dependencies.gateNode.submit(rawTx);
      await stateStore.recordTag({
        txid: submission.txid,
        label: agentAction.label,
        summary,
      });

      return sendRememberedOutcome({
        reply,
        stateStore,
        txid: submission.txid,
        outcome: "tag",
        httpStatus: 200,
        responseBody: {
        status: "submitted",
        txid: submission.txid,
        action: "tag",
        label: agentAction.label,
        },
      });
    }

    if (agentAction.action === "drop") {
      return sendRememberedOutcome({
        reply,
        stateStore,
        txid: summary.txid,
        outcome: "drop",
        httpStatus: 403,
        responseBody: {
        status: "dropped",
        txid: summary.txid,
        reason: agentAction.reason,
        },
      });
    }

    if (agentAction.action === "hold") {
      const hold = await stateStore.hold({
        rawTx,
        txid: summary.txid,
        reason: agentAction.reason,
        summary,
      });

      return sendRememberedOutcome({
        reply,
        stateStore,
        txid: summary.txid,
        outcome: "hold",
        httpStatus: 202,
        responseBody: {
        status: "held",
        txid: summary.txid,
        holdId: hold.holdId,
        reason: agentAction.reason,
        },
      });
    }

    if (agentAction.action === "shadow_drop") {
      await stateStore.shadowDrop({
        rawTx,
        txid: summary.txid,
        reason: agentAction.reason,
        summary,
      });

      return sendRememberedOutcome({
        reply,
        stateStore,
        txid: summary.txid,
        outcome: "shadow_drop",
        httpStatus: 200,
        responseBody: {
        txid: summary.txid,
        },
      });
    }

    assertNever(agentAction);
  });

  app.post("/v1/state/reset", async () => {
    await stateStore.reset();

    return {
      status: "reset",
    };
  });

  return app;
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
    shadowDrop() {},
    reset() {},
  };
}

async function sendRememberedOutcome(input: {
  reply: FastifyReply;
  stateStore: BouncerStateStore;
  txid: string;
  outcome: string;
  httpStatus: number;
  responseBody: unknown;
}) {
  await input.stateStore.recordAuditEvent({
    txid: input.txid,
    outcome: input.outcome,
    responseBody: input.responseBody,
  });
  await input.stateStore.rememberIdempotencyRecord({
    txid: input.txid,
    httpStatus: input.httpStatus,
    responseBody: input.responseBody,
  });

  return input.reply.status(input.httpStatus).send(input.responseBody);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Agent Action: ${JSON.stringify(value)}`);
}
