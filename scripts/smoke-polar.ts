#!/usr/bin/env tsx
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createBitcoinCoreRpc } from "../src/bitcoin-core-rpc.js";
import { runFuzzCandidates } from "../src/fuzz-candidate-runner.js";

type SmokeStep = {
  name: string;
  status: "passed" | "failed" | "skipped";
  detail?: unknown;
};

type SubmitResponse =
  | { txid: string; status?: string; action?: string }
  | Record<string, unknown>;

type FuzzSubmitResult = {
  rawTx: string;
  response: SubmitResponse;
};

const config = {
  bouncerUrl: process.env.BOUNCER_URL ?? "http://127.0.0.1:3130",
  port: process.env.PORT ?? "3130",
  promptPath: process.env.BOUNCER_PROMPT_PATH ?? "bouncer.prompt.md",
  stateDbPath: process.env.BOUNCER_STATE_DB_PATH ?? "state/smoke-bouncer.sqlite",
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
  fuzzCount: parsePositiveInteger(process.env.FUZZ_COUNT, 1),
  fuzzAmountBtc: parsePositiveNumber(process.env.FUZZ_AMOUNT_BTC, 0.00001),
};

const steps: SmokeStep[] = [];
let bouncer: ChildProcessWithoutNullStreams | undefined;

try {
  await requireModelEndpoint();
  await requireBitcoinRpc("Gate Node", config.gateNodeUrl);

  for (const witness of parseWitnesses(config.witnesses)) {
    await requireBitcoinRpc(`Propagation Witness ${witness.name}`, witness.rpcUrl);
  }

  await mkdir("state", { recursive: true });
  bouncer = await startBouncerRuntime();
  await resetState();
  await submitMalformedCandidate();
  const submitResult = await submitFuzzCandidate();
  const submitResponse = submitResult.response;
  const txid = extractTxid(submitResponse);
  const duplicateResponse = await submitRawTransaction(submitResult.rawTx);
  assertJsonEqual(duplicateResponse, submitResponse, "duplicate submit outcome");
  pass("Duplicate submit returned Idempotency Record", duplicateResponse);
  const audit = await fetchJson(`${config.bouncerUrl}/v1/audit?txid=${txid}`);
  assertAuditMatches({ audit, txid, response: submitResponse });
  pass("Audit event recorded", audit);

  if (isSubmitted(submitResponse)) {
    await verifyPropagation(txid, "present");
    assertNoLiveAgentFallback(audit);
  } else {
    await verifyPropagation(txid, "absent");
    await inspectWithheldOutcome(txid, submitResponse);
  }

  await resetState();
  pass("smoke complete", { txid, submitResponse });
} catch (error) {
  fail("smoke failed", errorMessage(error));
  process.exitCode = 1;
} finally {
  bouncer?.kill("SIGTERM");
  console.log(JSON.stringify({ steps }, null, 2));
}

async function requireModelEndpoint() {
  if (!config.modelBaseUrl || !config.modelName) {
    throw new Error(
      "BOUNCER_MODEL_BASE_URL and BOUNCER_MODEL_NAME are required for a real Pi-backed smoke test.",
    );
  }

  await fetchJson(`${trimTrailingSlash(config.modelBaseUrl)}/v1/models`);
  pass("model endpoint reachable", {
    baseUrl: config.modelBaseUrl,
    model: config.modelName,
  });
}

async function requireBitcoinRpc(name: string, url: string) {
  const rpc = createBitcoinCoreRpc({
    url,
    username: config.rpcUser,
    password: config.rpcPassword,
  });
  const info = await rpc("getblockchaininfo", []);

  pass(`${name} RPC reachable`, info);
}

async function startBouncerRuntime() {
  const child = spawn("npm", ["run", "dev"], {
    env: {
      ...process.env,
      PORT: config.port,
      BOUNCER_PROMPT_PATH: config.promptPath,
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
    },
    stdio: "pipe",
  });

  child.stdout.on("data", (chunk) => process.stderr.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  await waitForHealth();
  const health = await fetchText(`${config.bouncerUrl}/v1/health`);
  assertDoesNotContainSecrets(health);
  pass("Bouncer Runtime ready", JSON.parse(health));

  return child;
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

async function resetState() {
  const response = await fetchJson(`${config.bouncerUrl}/v1/state/reset`, {
    method: "POST",
  });
  pass("Bouncer state reset", response);
}

async function submitMalformedCandidate() {
  const response = await fetchJson(`${config.bouncerUrl}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rawTx: "not-a-raw-transaction" }),
    expectedStatuses: [400],
  });

  assertJsonEqual(
    response,
    {
      status: "parse_failure",
      reason: "TX decode failed",
    },
    "malformed candidate response",
  );
  pass("Malformed candidate rejected before Live Agent", response);
}

async function submitFuzzCandidate(): Promise<FuzzSubmitResult> {
  const walletRpc = createBitcoinCoreRpc({
    url: config.gateNodeUrl,
    username: config.rpcUser,
    password: config.rpcPassword,
  });
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
        });
      },
    },
    count: config.fuzzCount,
    amountBtc: config.fuzzAmountBtc,
  });

  pass("Fuzz Candidate submitted through Bouncer", result.response);
  return {
    rawTx: result.rawTx,
    response: result.response as SubmitResponse,
  };
}

async function submitRawTransaction(rawTx: string) {
  return fetchJson(`${config.bouncerUrl}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rawTx }),
  }) as Promise<SubmitResponse>;
}

async function verifyPropagation(txid: string, expected: "present" | "absent") {
  const child = spawn("npm", ["run", "--silent", "verify:propagation"], {
    env: {
      ...process.env,
      TXID: txid,
      EXPECTED: expected,
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

  pass(`Propagation ${expected}`, JSON.parse(output));
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

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${body}`);
  }

  return body;
}

function extractTxid(response: SubmitResponse): string {
  if (typeof response.txid === "string") {
    return response.txid;
  }

  throw new Error(`Submit response did not include txid: ${JSON.stringify(response)}`);
}

function isSubmitted(response: SubmitResponse): boolean {
  return response.status === "submitted";
}

async function inspectWithheldOutcome(txid: string, response: SubmitResponse) {
  if (
    response.status === "held" &&
    "holdId" in response &&
    typeof response.holdId === "string"
  ) {
    pass(
      "Hold Queue record inspectable",
      await fetchJson(`${config.bouncerUrl}/v1/holds/${response.holdId}`),
    );
    return;
  }

  if (response.status === "dropped") {
    pass("Honest drop withheld from Gate Node", response);
    return;
  }

  if (!response.status) {
    pass(
      "Shadow Realm record inspectable",
      await fetchJson(`${config.bouncerUrl}/v1/shadow-realm/${txid}`),
    );
  }
}

function assertAuditMatches(input: {
  audit: unknown;
  txid: string;
  response: SubmitResponse;
}) {
  if (!isRecord(input.audit) || !Array.isArray(input.audit.events)) {
    throw new Error(`Audit response malformed: ${JSON.stringify(input.audit)}`);
  }

  const [event] = input.audit.events;

  if (!isRecord(event) || event.txid !== input.txid) {
    throw new Error(`Audit response missing txid ${input.txid}`);
  }

  if (event.promptHash !== undefined && typeof event.promptHash !== "string") {
    throw new Error(`Audit prompt hash malformed: ${JSON.stringify(event)}`);
  }
}

function assertNoLiveAgentFallback(audit: unknown) {
  const serialized = JSON.stringify(audit);

  if (serialized.includes("live_agent_fallback")) {
    throw new Error(`Expected real model action, got fallback audit: ${serialized}`);
  }
}

function assertDoesNotContainSecrets(body: string) {
  for (const secret of [config.rpcUser, config.rpcPassword, config.gateNodeUrl]) {
    if (secret && body.includes(secret)) {
      throw new Error(`Health response leaked secret/config value: ${secret}`);
    }
  }
}

function assertJsonEqual(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Unexpected ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function pass(name: string, detail?: unknown) {
  steps.push({ name, status: "passed", detail });
}

function fail(name: string, detail?: unknown) {
  steps.push({ name, status: "failed", detail });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
