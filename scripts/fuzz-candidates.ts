#!/usr/bin/env tsx
import { createBitcoinCoreRpc } from "../src/bitcoin-core-rpc.js";
import {
  createDemoRunEventPublisher,
  createRunId,
} from "../src/demo-run-events.js";
import {
  allFuzzCandidateShapes,
  type FuzzCandidateContext,
  parseFuzzCandidateShapes,
  runFuzzCandidates,
} from "../src/fuzz-candidate-runner.js";

const bouncerUrl = process.env.BOUNCER_URL ?? "http://127.0.0.1:3000";
const amountBtc = parsePositiveNumber(process.env.FUZZ_AMOUNT_BTC, 0.00001);
const candidateShapes =
  parseFuzzCandidateShapes(process.env.FUZZ_CANDIDATE_SHAPES) ?? [
    ...allFuzzCandidateShapes,
  ];
const count = parsePositiveInteger(process.env.FUZZ_COUNT, candidateShapes.length);
const runId = process.env.BOUNCER_DEMO_RUN_ID ?? createRunId("fuzz");
const runEventPublisher = createDemoRunEventPublisher({
  bouncerUrl,
  eventUrl: process.env.BOUNCER_DEMO_EVENTS_URL,
});

await runEventPublisher.publish({
  runId,
  source: "fuzz",
  name: "Fuzz Candidate build started",
  status: "running",
  detail: {
    count,
    amountBtc,
    candidateShapes,
  },
});

const walletRpc = createBitcoinCoreRpc({
  url: process.env.BITCOIN_RPC_URL ?? "http://127.0.0.1:18443",
  username: process.env.BITCOIN_RPC_USER ?? "polaruser",
  password: process.env.BITCOIN_RPC_PASSWORD ?? "polarpass",
});

const wallet = {
  getNewAddress() {
    return walletRpc("getnewaddress", []) as Promise<string>;
  },
  walletCreateFundedPsbt(
    inputs: unknown[],
    outputs: Array<Record<string, number>>,
    locktime: number,
    options: Record<string, unknown>,
    bip32derivs: boolean,
  ) {
    return walletRpc("walletcreatefundedpsbt", [
      inputs,
      outputs,
      locktime,
      options,
      bip32derivs,
    ]) as Promise<{ psbt: string }>;
  },
  walletProcessPsbt(psbt: string) {
    return walletRpc("walletprocesspsbt", [psbt]) as Promise<{ psbt: string }>;
  },
  finalizePsbt(psbt: string) {
    return walletRpc("finalizepsbt", [psbt]) as Promise<{
      hex: string;
      complete: boolean;
    }>;
  },
};

const bouncer = {
  async submitRawTransaction(rawTx: string, context: FuzzCandidateContext) {
    await runEventPublisher.publish({
      runId,
      source: "fuzz",
      name: "Fuzz Candidate submitted to Bouncer",
      status: "running",
      detail: {
        shape: context.shape,
        candidateNumber: context.index + 1,
        candidateCount: context.count,
        rawTxBytes: rawTx.length / 2,
        rawTxPrefix: rawTx.slice(0, 24),
        bouncerUrl,
      },
    });

    const response = await fetch(`${bouncerUrl}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawTx }),
    });

    const body = (await response.json()) as unknown;

    if (!response.ok && response.status !== 403) {
      throw new Error(
        `Bouncer submit failed with HTTP ${response.status}: ${JSON.stringify(body)}`,
      );
    }

    await runEventPublisher.publish({
      runId,
      source: "fuzz",
      name: "Fuzz Candidate accepted by Bouncer",
      status: "passed",
      detail: await fuzzSubmitDetail(body, context),
    });

    return body;
  },
};

const results = await runFuzzCandidates({
  wallet,
  bouncer,
  count,
  amountBtc,
  candidateShapes,
});

await runEventPublisher.publish({
  runId,
  source: "fuzz",
  name: "Fuzz Candidate batch submitted through Bouncer",
  status: "passed",
  detail: results.map((result) => ({
    shape: result.shape,
    action: actionFromUnknownResponse(result.response),
    handling: handlingFromUnknownResponse(result.response),
    response: result.response,
  })),
});

for (const result of results) {
  console.log(JSON.stringify(result));
}

await runEventPublisher.flush();

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parsePositiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number.parseFloat(value ?? String(fallback));

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

async function fuzzSubmitDetail(
  response: unknown,
  context: FuzzCandidateContext,
) {
  if (!response || typeof response !== "object") {
    return {
      shape: context.shape,
      candidateNumber: context.index + 1,
      candidateCount: context.count,
      submitterResponse: response,
    };
  }

  const record = response as Record<string, unknown>;
  const txid = typeof record.txid === "string" ? record.txid : undefined;
  const audit = txid
    ? await fetch(`${bouncerUrl}/v1/audit?txid=${txid}`)
        .then((auditResponse) => auditResponse.json() as Promise<unknown>)
        .catch(() => undefined)
    : undefined;
  const action = actionFromResponse(record, audit);

  return {
    shape: context.shape,
    candidateNumber: context.index + 1,
    candidateCount: context.count,
    ...(typeof action === "string" ? { action } : {}),
    ...(txid ? { txid } : {}),
    handling: handlingFromResponse(record),
    ...(audit ? { audit, fallback: readLiveAgentFallback(audit) } : {}),
    submitterResponse: response,
  };
}

function actionFromUnknownResponse(response: unknown) {
  if (!response || typeof response !== "object") {
    return undefined;
  }

  return actionFromResponse(response as Record<string, unknown>, undefined);
}

function handlingFromUnknownResponse(response: unknown) {
  if (!response || typeof response !== "object") {
    return undefined;
  }

  return handlingFromResponse(response as Record<string, unknown>);
}

function actionFromResponse(response: Record<string, unknown>, audit: unknown) {
  if (typeof response.action === "string") {
    return response.action;
  }

  if (response.status === "dropped") {
    return "drop";
  }

  if (response.status === "held") {
    return "hold";
  }

  return readAuditOutcome(audit);
}

function readAuditOutcome(audit: unknown) {
  if (!audit || typeof audit !== "object") {
    return undefined;
  }

  const events = (audit as Record<string, unknown>).events;

  if (!Array.isArray(events)) {
    return undefined;
  }

  const [event] = events;

  if (!event || typeof event !== "object") {
    return undefined;
  }

  const outcome = (event as Record<string, unknown>).outcome;

  return typeof outcome === "string" ? outcome : undefined;
}

function readLiveAgentFallback(audit: unknown) {
  if (!audit || typeof audit !== "object") {
    return undefined;
  }

  const events = (audit as Record<string, unknown>).events;

  if (!Array.isArray(events)) {
    return undefined;
  }

  for (const event of events) {
    if (!event || typeof event !== "object") {
      continue;
    }

    const responseBody = (event as Record<string, unknown>).responseBody;

    if (!responseBody || typeof responseBody !== "object") {
      continue;
    }

    const internal = (responseBody as Record<string, unknown>).internal;

    if (!internal || typeof internal !== "object") {
      continue;
    }

    const fallback = (internal as Record<string, unknown>).liveAgentFallback;

    if (typeof fallback === "string") {
      return fallback;
    }
  }

  return undefined;
}

function handlingFromResponse(response: Record<string, unknown>) {
  if (response.status === "submitted") {
    return response.action === "tag"
      ? "tagged-and-submitted-to-gate-node"
      : "submitted-to-gate-node";
  }

  if (response.status === "held") {
    return "withheld-in-hold-queue";
  }

  if (response.status === "dropped") {
    return "honestly-dropped";
  }

  if (!("status" in response) && typeof response.txid === "string") {
    return "shadow-realm-txid-only-response";
  }

  return "unknown";
}
