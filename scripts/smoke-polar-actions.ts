#!/usr/bin/env tsx
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { createBitcoinCoreRpc } from "../src/bitcoin-core-rpc.js";
import {
  createDemoRunEventPublisher,
  createRunId,
} from "../src/demo-run-events.js";
import {
  expectedForcedActionOutcome,
  type ForcedSmokeAction,
  validateForcedActionObservation,
  writeSmokeDirectivePrompt,
} from "../src/forced-action-smoke.js";
import {
  parseFuzzCandidateShapes,
  runFuzzCandidates,
} from "../src/fuzz-candidate-runner.js";

type SmokeStep = {
  action?: ForcedSmokeAction;
  name: string;
  status: "passed" | "failed";
  detail?: unknown;
};

type SubmitResponse =
  | { txid: string; status?: string; action?: string; holdId?: string }
  | Record<string, unknown>;

const config = {
  bouncerUrl: process.env.BOUNCER_URL ?? "http://127.0.0.1:3131",
  port: process.env.PORT ?? "3131",
  promptPath: process.env.BOUNCER_PROMPT_PATH ?? "bouncer.prompt.md",
  promptDirectory:
    process.env.SMOKE_DIRECTIVE_PROMPT_DIR ?? "state/smoke-prompts",
  stateDbPath:
    process.env.BOUNCER_STATE_DB_PATH ?? "state/forced-smoke-bouncer.sqlite",
  gateNodeName: process.env.BITCOIN_GATE_NODE_NAME ?? "backend1",
  gateNodeUrl: process.env.BITCOIN_RPC_URL ?? "http://127.0.0.1:18443",
  rpcUser: process.env.BITCOIN_RPC_USER ?? "polaruser",
  rpcPassword: process.env.BITCOIN_RPC_PASSWORD ?? "polarpass",
  witnesses:
    process.env.BITCOIN_PROPAGATION_WITNESSES ??
    "backend2=http://127.0.0.1:18444,backend3=http://127.0.0.1:18445",
  modelBaseUrl: process.env.BOUNCER_MODEL_BASE_URL,
  modelApiKey: process.env.BOUNCER_MODEL_API_KEY ?? "smoke-key",
  modelName: process.env.BOUNCER_MODEL_NAME,
  modelTimeoutMs: process.env.BOUNCER_MODEL_TIMEOUT_MS ?? "30000",
  useModel:
    process.env.FORCED_ACTIONS_USE_MODEL === "1" ||
    process.env.FORCED_ACTIONS_USE_MODEL === "true",
  actions: parseForcedActions(
    process.env.FORCED_ACTIONS ?? "pass,tag,hold,drop,shadow_drop",
  ),
  candidateShapes:
    parseFuzzCandidateShapes(process.env.FUZZ_CANDIDATE_SHAPES) ?? [
      "standard-single-output",
    ],
};

const steps: SmokeStep[] = [];
const runId = process.env.BOUNCER_DEMO_RUN_ID ?? createRunId("smoke");
const runEventPublisher = createDemoRunEventPublisher({
  bouncerUrl: config.bouncerUrl,
  eventUrl: process.env.BOUNCER_DEMO_EVENTS_URL,
});

try {
  await requireModelEndpoint();
  await requireBitcoinRpc("Gate Node", config.gateNodeUrl);

  for (const witness of parseWitnesses(config.witnesses)) {
    await requireBitcoinRpc(`Propagation Witness ${witness.name}`, witness.rpcUrl);
  }

  await mkdir(config.promptDirectory, { recursive: true });
  const basePrompt = await readFile(config.promptPath, "utf8");

  for (const action of config.actions) {
    await runForcedAction({ action, basePrompt });
  }
} catch (error) {
  fail({ name: "forced-action smoke failed", detail: errorMessage(error) });
  process.exitCode = 1;
} finally {
  await runEventPublisher.flush();
  console.log(JSON.stringify({ steps }, null, 2));
}

async function runForcedAction(input: {
  action: ForcedSmokeAction;
  basePrompt: string;
}) {
  const promptPath = await writeSmokeDirectivePrompt({
    directory: config.promptDirectory,
    basePrompt: input.basePrompt,
    action: input.action,
  });
  const bouncer = await startBouncerRuntime({
    promptPath,
    action: input.action,
  });

  try {
    await resetState(input.action);
    const { rawTx, response } = await submitFuzzCandidate();
    const txid = extractTxid(response);
    const audit = await fetchJson(`${config.bouncerUrl}/v1/audit?txid=${txid}`);
    validateForcedActionObservation({
      action: input.action,
      response,
      audit,
	    });
	    pass({
	      action: input.action,
	      name: `Forced ${input.action} observed`,
	      detail: forcedActionDetail({
	        action: input.action,
	        txid,
	        response,
	        audit,
	      }),
	    });

    const expectation = expectedForcedActionOutcome(input.action);
    await verifyPropagation({
      action: input.action,
      txid,
      expected: expectation.propagation,
    });
    await inspectOperatorEvidence({
      action: input.action,
      txid,
      response,
    });
    await resetState(input.action);
    pass({
      action: input.action,
      name: `Forced ${input.action} complete`,
      detail: {
        action: input.action,
        txid,
        promptPath,
        handling: actionHandling(input.action),
      },
    });

    if (input.action === "pass" || input.action === "tag") {
      await spendMempoolTransaction(rawTx);
    }
  } finally {
    await stopBouncerRuntime(bouncer);
  }
}

async function requireModelEndpoint() {
  if (!config.modelBaseUrl || !config.modelName) {
    throw new Error(
      "BOUNCER_MODEL_BASE_URL and BOUNCER_MODEL_NAME are required for forced-action smoke.",
    );
  }

  await fetchJson(`${trimTrailingSlash(config.modelBaseUrl)}/v1/models`);
  pass({
    name: "model endpoint reachable",
    detail: { baseUrl: config.modelBaseUrl, model: config.modelName },
  });
}

async function requireBitcoinRpc(name: string, url: string) {
  const rpc = createBitcoinCoreRpc({
    url,
    username: config.rpcUser,
    password: config.rpcPassword,
  });
  pass({ name: `${name} RPC reachable`, detail: await rpc("getblockchaininfo", []) });
}

async function startBouncerRuntime(input: {
  promptPath: string;
  action: ForcedSmokeAction;
}) {
  const child = spawn("npx", ["tsx", "src/server.ts"], {
    env: {
      ...process.env,
      PORT: config.port,
      BOUNCER_PROMPT_PATH: input.promptPath,
      BOUNCER_STATE_DB_PATH: config.stateDbPath,
      BITCOIN_GATE_NODE_NAME: config.gateNodeName,
      BITCOIN_RPC_URL: config.gateNodeUrl,
      BITCOIN_RPC_USER: config.rpcUser,
      BITCOIN_RPC_PASSWORD: config.rpcPassword,
      BITCOIN_PROPAGATION_WITNESSES: config.witnesses,
      BOUNCER_MODEL_BASE_URL: config.modelBaseUrl,
      BOUNCER_MODEL_API_KEY: config.modelApiKey,
      BOUNCER_MODEL_NAME: config.modelName,
      BOUNCER_MODEL_TIMEOUT_MS: config.modelTimeoutMs,
      ...(config.useModel ? {} : { BOUNCER_FORCE_ACTION: input.action }),
    },
    stdio: "pipe",
  });

  child.stdout.on("data", (chunk) => process.stderr.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitForHealth();
  pass({
    action: input.action,
    name: "Bouncer Runtime ready",
    detail: await fetchJson(`${config.bouncerUrl}/v1/health`),
  });

  return child;
}

async function stopBouncerRuntime(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.on("close", () => resolve())),
    delay(2_000),
  ]);
}

async function waitForHealth() {
  const startedAt = Date.now();
  let lastError = "health check not attempted";

  while (Date.now() - startedAt < 10_000) {
    try {
      await fetchJson(`${config.bouncerUrl}/v1/health`);
      return;
    } catch (error) {
      lastError = errorMessage(error);
      await delay(250);
    }
  }

  throw new Error(`Bouncer Runtime did not become ready: ${lastError}`);
}

async function resetState(action: ForcedSmokeAction) {
  pass({
    action,
    name: "Bouncer state reset",
    detail: await fetchJson(`${config.bouncerUrl}/v1/state/reset`, {
      method: "POST",
    }),
  });
}

async function submitFuzzCandidate() {
  const walletRpc = walletRpcClient();
  const [result] = await runFuzzCandidates({
    wallet: {
      getNewAddress() {
        return walletRpc("getnewaddress", []) as Promise<string>;
      },
      walletCreateFundedPsbt(inputs, outputs, locktime, options, bip32derivs) {
        return walletRpc("walletcreatefundedpsbt", [
          inputs,
          outputs,
          locktime,
          options,
          bip32derivs,
        ]) as Promise<{ psbt: string }>;
      },
      walletProcessPsbt(psbt) {
        return walletRpc("walletprocesspsbt", [psbt]) as Promise<{ psbt: string }>;
      },
      finalizePsbt(psbt) {
        return walletRpc("finalizepsbt", [psbt]) as Promise<{
          hex: string;
          complete: boolean;
        }>;
      },
    },
    bouncer: {
      async submitRawTransaction(rawTx) {
        return fetchJson(`${config.bouncerUrl}/submit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rawTx }),
          expectedStatuses: [200, 202, 403],
        });
      },
    },
    count: 1,
    amountBtc: 0.00001,
    candidateShapes: config.candidateShapes,
  });

  return {
    rawTx: result.rawTx,
    response: result.response as SubmitResponse,
  };
}

async function verifyPropagation(input: {
  action: ForcedSmokeAction;
  txid: string;
  expected: "present" | "absent";
}) {
  const child = spawn("npm", ["run", "--silent", "verify:propagation"], {
    env: {
      ...process.env,
      TXID: input.txid,
      EXPECTED: input.expected,
      BITCOIN_GATE_NODE_NAME: config.gateNodeName,
      BITCOIN_RPC_URL: config.gateNodeUrl,
      BITCOIN_RPC_USER: config.rpcUser,
      BITCOIN_RPC_PASSWORD: config.rpcPassword,
      BITCOIN_PROPAGATION_WITNESSES: config.witnesses,
      PROPAGATION_TIMEOUT_MS: process.env.PROPAGATION_TIMEOUT_MS ?? "10000",
      PROPAGATION_POLL_INTERVAL_MS:
        process.env.PROPAGATION_POLL_INTERVAL_MS ?? "500",
    },
    stdio: "pipe",
  });
  const output = await collectProcessOutput(child);

  if (child.exitCode !== 0) {
    throw new Error(`Propagation verification failed: ${output}`);
  }

  pass({
    action: input.action,
    name: `Propagation ${input.expected}`,
    detail: JSON.parse(output),
  });
}

async function inspectOperatorEvidence(input: {
  action: ForcedSmokeAction;
  txid: string;
  response: SubmitResponse;
}) {
  if (
    input.action === "hold" &&
    "holdId" in input.response &&
    typeof input.response.holdId === "string"
  ) {
    const holds = await fetchJson(`${config.bouncerUrl}/v1/holds`);

    pass({
      action: input.action,
      name: "Hold Queue record inspectable",
      detail: findHoldRecord({
        holds,
        holdId: input.response.holdId,
      }),
    });
    return;
  }

  if (input.action === "shadow_drop") {
    pass({
      action: input.action,
      name: "Shadow Realm record inspectable",
      detail: await fetchJson(`${config.bouncerUrl}/v1/shadow-realm/${input.txid}`),
    });
    return;
  }

  if (input.action === "tag") {
    pass({
      action: input.action,
      name: "Tag label observed",
      detail: input.response,
    });
    return;
  }

  if (input.action === "drop") {
    pass({
      action: input.action,
      name: "Honest drop audit observed",
      detail: input.response,
    });
  }
}

async function spendMempoolTransaction(rawTx: string) {
  const rpc = walletRpcClient();
  const decoded = (await rpc("decoderawtransaction", [rawTx])) as { txid: string };
  const address = (await rpc("getnewaddress", [])) as string;
  await rpc("generatetoaddress", [1, address]);
  pass({
    name: "Mempool transaction mined for next forced action",
    detail: { txid: decoded.txid },
  });
}

function walletRpcClient() {
  return createBitcoinCoreRpc({
    url: config.gateNodeUrl,
    username: config.rpcUser,
    password: config.rpcPassword,
  });
}

function findHoldRecord(input: { holds: unknown; holdId: string }) {
  if (!isRecord(input.holds) || !Array.isArray(input.holds.holds)) {
    throw new Error(`Hold Queue response malformed: ${JSON.stringify(input.holds)}`);
  }

  const hold = input.holds.holds.find(
    (entry) => isRecord(entry) && entry.holdId === input.holdId,
  );

  if (!hold) {
    throw new Error(`Hold Queue record not found: ${input.holdId}`);
  }

  return hold;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function fetchJson(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    expectedStatuses?: number[];
  },
): Promise<unknown> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => undefined);
  const expectedStatuses = init?.expectedStatuses ?? [];

  if (!response.ok && !expectedStatuses.includes(response.status)) {
    throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(body)}`);
  }

  return body;
}

async function collectProcessOutput(child: ChildProcessWithoutNullStreams) {
  let output = "";
  let errorOutput = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    errorOutput += String(chunk);
  });
  await new Promise<void>((resolve) => child.on("close", () => resolve()));

  return output.trim() || errorOutput.trim();
}

function extractTxid(response: SubmitResponse): string {
  if (typeof response.txid === "string") {
    return response.txid;
  }

  throw new Error(`Submit response did not include txid: ${JSON.stringify(response)}`);
}

function parseForcedActions(value: string): ForcedSmokeAction[] {
  return value.split(",").map((rawAction) => {
    const action = rawAction.trim();

    if (
      action === "pass" ||
      action === "tag" ||
      action === "hold" ||
      action === "drop" ||
      action === "shadow_drop"
    ) {
      return action;
    }

    throw new Error(`Unknown forced smoke action: ${rawAction}`);
  });
}

function parseWitnesses(value: string) {
  return value.split(",").map((entry) => {
    const [name, rpcUrl] = entry.split("=");

    if (!name || !rpcUrl) {
      throw new Error(
        `Invalid BITCOIN_PROPAGATION_WITNESSES entry "${entry}". Expected name=rpcUrl.`,
      );
    }

    return {
      name: name.trim(),
      rpcUrl: rpcUrl.trim(),
    };
  });
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function forcedActionDetail(input: {
  action: ForcedSmokeAction;
  txid: string;
  response: SubmitResponse;
  audit: unknown;
}) {
  return {
    action: input.action,
    txid: input.txid,
    handling: actionHandling(input.action),
    submitterResponse: input.response,
    audit: input.audit,
  };
}

function actionHandling(action: ForcedSmokeAction) {
  if (action === "pass") {
    return "submitted-to-gate-node";
  }

  if (action === "tag") {
    return "tagged-and-submitted-to-gate-node";
  }

  if (action === "hold") {
    return "withheld-in-hold-queue";
  }

  if (action === "drop") {
    return "honestly-dropped";
  }

  return "shadow-realm-txid-only-response";
}

function pass(step: Omit<SmokeStep, "status">) {
  const event = { ...step, status: "passed" as const };
  steps.push(event);
  void runEventPublisher.publish({
    runId,
    source: step.name.startsWith("Propagation ") ? "propagation" : "smoke",
    name: step.name,
    status: event.status,
    detail: event.detail,
  });
}

function fail(step: Omit<SmokeStep, "status">) {
  const event = { ...step, status: "failed" as const };
  steps.push(event);
  void runEventPublisher.publish({
    runId,
    source: "smoke",
    name: step.name,
    status: event.status,
    detail: event.detail,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
