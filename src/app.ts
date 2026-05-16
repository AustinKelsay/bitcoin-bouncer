import { spawn } from "node:child_process";
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

const recordRunEventSchema = z.object({
  runId: z.string().min(1),
  source: z.enum(["smoke", "fuzz", "propagation"]),
  name: z.string().min(1),
  status: z.enum(["running", "passed", "failed", "skipped"]),
  detail: z.unknown().optional(),
});

const startDemoRunSchema = z.object({
  kind: z.enum(["smoke", "forced_actions", "model_compliance", "fuzz"]),
});

const savePromptSchema = z.object({
  prompt: z.string().min(1),
});

type DemoRunKind = z.infer<typeof startDemoRunSchema>["kind"];
type DemoRunEventInput = Parameters<
  NonNullable<BouncerStateStore["recordRunEvent"]>
>[0];

type RuntimeMetadata = {
  prompt?: string;
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
  savePrompt?: (
    prompt: string,
  ) => Promise<{ prompt: string; promptHash: string }>;
  demoRunTrigger?: (input: {
    kind: DemoRunKind;
    runId: string;
    recordEvent: (event: DemoRunEventInput) => Promise<void>;
  }) => Promise<void>;
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
  const triggerDemoRun = dependencies.demoRunTrigger ?? triggerDemoRunScript;
  const runEventStream = new RunEventStream();
  const runtime = dependencies.runtime
    ? {
        ...dependencies.runtime,
        propagationWitnessNames: [
          ...dependencies.runtime.propagationWitnessNames,
        ],
      }
    : undefined;
  let activeDemoRunId: string | undefined;

  app.get("/v1/health", async () => {
    return {
      status: "ready",
      prompt: runtime?.prompt,
      promptHash: runtime?.promptHash,
      gateNode: runtime?.gateNodeName,
      propagationWitnesses: runtime?.propagationWitnessNames ?? [],
    };
  });

  app.put("/v1/prompt", async (request, reply) => {
    const parsed = savePromptSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        status: "bad_request",
        reason: "prompt is required",
      });
    }

    if (!dependencies.savePrompt) {
      return reply.status(503).send({
        status: "prompt_edit_unavailable",
        reason: "Bouncer Prompt editing is not configured for this runtime",
      });
    }

    const saved = await dependencies.savePrompt(parsed.data.prompt);
    if (runtime) {
      runtime.prompt = saved.prompt;
      runtime.promptHash = saved.promptHash;
    }
    const activePromptHash = runtime?.promptHash ?? saved.promptHash;

    return {
      status: "saved",
      prompt: saved.prompt,
      promptHash: saved.promptHash,
      activePromptHash,
      requiresRestart: false,
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

  app.get("/v1/demo/events", async () => {
    const events = await stateStore.listRunEvents?.();

    return { events: events ?? [] };
  });

  app.get("/v1/demo/events/stream", async (request, reply) => {
    const query = request.query as { once?: string };

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    reply.raw.write(": connected\n\n");

    const unsubscribe = runEventStream.subscribe((event) => {
      reply.raw.write(`event: run-event\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);

      if (query.once === "1") {
        reply.raw.end();
      }
    });
    reply.raw.on("close", unsubscribe);

    return reply;
  });

  app.post("/v1/demo/events", async (request, reply) => {
    const parsed = recordRunEventSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        status: "bad_request",
        reason: "runId, source, name, and status are required",
      });
    }

    const event = await recordDemoRunEvent(parsed.data);

    return { event };
  });

  app.delete("/v1/demo/events", async () => {
    await stateStore.clearRunEvents?.();

    return { status: "cleared" };
  });

  app.post("/v1/demo/runs", async (request, reply) => {
    const parsed = startDemoRunSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        status: "bad_request",
        reason: "kind must be smoke, forced_actions, model_compliance, or fuzz",
      });
    }

    if (activeDemoRunId) {
      return reply.status(409).send({
        status: "run_already_active",
        runId: activeDemoRunId,
      });
    }

    const runId = createRunId(parsed.data.kind);
    activeDemoRunId = runId;
    await recordDemoRunEvent({
      runId,
      source: demoRunSource(parsed.data.kind),
      name: `${demoRunLabel(parsed.data.kind)} started`,
      status: "running",
      detail: demoRunStartDetail(parsed.data.kind),
    });

    void triggerDemoRun({
      kind: parsed.data.kind,
      runId,
      recordEvent: async (event) => {
        await recordDemoRunEvent(event);
      },
    })
      .then(async () => {
        await recordDemoRunEvent({
          runId,
          source: demoRunSource(parsed.data.kind),
          name: `${demoRunLabel(parsed.data.kind)} finished`,
          status: "passed",
        });
      })
      .catch(async (error) => {
        await recordDemoRunEvent({
          runId,
          source: demoRunSource(parsed.data.kind),
          name: `${demoRunLabel(parsed.data.kind)} failed`,
          status: "failed",
          detail: errorMessage(error),
        });
      })
      .finally(() => {
        activeDemoRunId = undefined;
      });

    return reply.status(202).send({
      runId,
      kind: parsed.data.kind,
      status: "running",
    });
  });

  async function recordDemoRunEvent(event: DemoRunEventInput) {
    const storedEvent = await stateStore.recordRunEvent?.(event);

    if (storedEvent) {
      runEventStream.publish(storedEvent);
    }

    return storedEvent;
  }

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
        runtime: runtime,
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
        runtime: runtime,
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
          runtime: runtime,
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
        runtime: runtime,
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
      runtime: runtime,
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
        runtime: runtime,
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
        runtime: runtime,
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
        runtime: runtime,
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
        runtime: runtime,
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

class RunEventStream {
  #subscribers = new Set<(event: unknown) => void>();

  subscribe(subscriber: (event: unknown) => void) {
    this.#subscribers.add(subscriber);

    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  publish(event: unknown) {
    for (const subscriber of this.#subscribers) {
      subscriber(event);
    }
  }
}

function createNoopStateStore(): BouncerStateStore {
  const runEvents: Awaited<
    ReturnType<NonNullable<BouncerStateStore["listRunEvents"]>>
  > = [];

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
    async listRunEvents() {
      return runEvents;
    },
    async recordRunEvent(event) {
      const storedEvent = {
        id: runEvents.length + 1,
        ...event,
        createdAt: new Date().toISOString(),
      };
      runEvents.push(storedEvent);

      return storedEvent;
    },
    async clearRunEvents() {
      runEvents.length = 0;
    },
    reset() {},
  };
}

async function triggerDemoRunScript(input: {
  kind: DemoRunKind;
  runId: string;
  recordEvent: (event: DemoRunEventInput) => Promise<void>;
}): Promise<void> {
  const child = spawn("npm", ["run", demoRunScript(input.kind)], {
    env: {
      ...process.env,
      ...demoRunEnvironment(input),
      BOUNCER_DEMO_RUN_ID: input.runId,
      BOUNCER_DEMO_EVENTS_URL:
        process.env.BOUNCER_DEMO_EVENTS_URL ??
        "http://127.0.0.1:3130/v1/demo/events",
    },
    stdio: "pipe",
  });

  const output = await collectProcessOutput(child);

  if (child.exitCode !== 0) {
    throw new Error(output || `${demoRunScript(input.kind)} exited ${child.exitCode}`);
  }

  await recordScriptSteps({
    kind: input.kind,
    runId: input.runId,
    output,
    recordEvent: input.recordEvent,
  });
}

function demoRunScript(kind: DemoRunKind) {
  if (kind === "model_compliance") {
    return "smoke:polar:model-compliance";
  }

  if (kind === "forced_actions") {
    return "smoke:polar:actions";
  }

  if (kind === "fuzz") {
    return "fuzz:candidates";
  }

  return "smoke:polar";
}

function demoRunEnvironment(input: { kind: DemoRunKind }) {
  if (input.kind === "fuzz") {
    return {
      BOUNCER_URL:
        process.env.BOUNCER_DEMO_API_URL ??
        process.env.BOUNCER_URL ??
        "http://127.0.0.1:3130",
    };
  }

  return {
    PORT: process.env.BOUNCER_TRIGGER_PORT ?? "3131",
    BOUNCER_URL:
      process.env.BOUNCER_TRIGGER_URL ??
      `http://127.0.0.1:${process.env.BOUNCER_TRIGGER_PORT ?? "3131"}`,
    BOUNCER_STATE_DB_PATH:
      process.env.BOUNCER_TRIGGER_STATE_DB_PATH ??
      `state/demo-trigger-${input.kind}.sqlite`,
  };
}

async function collectProcessOutput(
  child: ReturnType<typeof spawn>,
): Promise<string> {
  let output = "";
  let errorOutput = "";

  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    errorOutput += String(chunk);
  });

  await new Promise<void>((resolve) => child.on("close", () => resolve()));

  return [output.trim(), errorOutput.trim()].filter(Boolean).join("\n");
}

function createRunId(kind: DemoRunKind, date = new Date()) {
  return `${kind}-${date.toISOString().replaceAll(":", "-").replace(".", "-")}`;
}

function demoRunSource(kind: DemoRunKind) {
  return kind === "fuzz" ? "fuzz" : "smoke";
}

function demoRunLabel(kind: DemoRunKind) {
  if (kind === "model_compliance") {
    return "Model compliance smoke";
  }

  if (kind === "forced_actions") {
    return "Forced-action smoke";
  }

  return kind === "fuzz" ? "Fuzz run" : "Smoke run";
}

function demoRunStartDetail(kind: DemoRunKind) {
  return {
    command: `npm run ${demoRunScript(kind)}`,
    ...(kind === "fuzz"
      ? {
          bouncerUrl:
            process.env.BOUNCER_DEMO_API_URL ??
            process.env.BOUNCER_URL ??
            "http://127.0.0.1:3130",
        }
      : {
          bouncerUrl:
            process.env.BOUNCER_TRIGGER_URL ??
            `http://127.0.0.1:${process.env.BOUNCER_TRIGGER_PORT ?? "3131"}`,
        }),
  };
}

async function recordScriptSteps(input: {
  kind: DemoRunKind;
  runId: string;
  output: string;
  recordEvent: (event: DemoRunEventInput) => Promise<void>;
}) {
  const report = parseScriptReport(input.output);

  if (!report) {
    return;
  }

  for (const step of report.steps) {
    await input.recordEvent({
      runId: input.runId,
      source: step.name.startsWith("Propagation ")
        ? "propagation"
        : demoRunSource(input.kind),
      name: step.name,
      status: step.status,
      detail: step.detail,
    });
  }
}

function parseScriptReport(output: string):
  | {
      steps: Array<{
        name: string;
        status: "running" | "passed" | "failed" | "skipped";
        detail?: unknown;
      }>;
    }
  | undefined {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as unknown;

    if (!isRecord(parsed) || !Array.isArray(parsed.steps)) {
      return undefined;
    }

    return {
      steps: parsed.steps.flatMap((step: unknown) => {
        if (!isRecord(step) || typeof step.name !== "string") {
          return [];
        }

        if (
          step.status !== "running" &&
          step.status !== "passed" &&
          step.status !== "failed" &&
          step.status !== "skipped"
        ) {
          return [];
        }

        return [
          {
            name: step.name,
            status: step.status,
            detail: step.detail,
          },
        ];
      }),
    };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
