#!/usr/bin/env tsx
import { createBitcoinCoreRpc } from "../src/bitcoin-core-rpc.js";
import {
  parseFuzzCandidateShapes,
  runFuzzCandidates,
} from "../src/fuzz-candidate-runner.js";

const bouncerUrl = process.env.BOUNCER_URL ?? "http://127.0.0.1:3000";
const count = parsePositiveInteger(process.env.FUZZ_COUNT, 1);
const amountBtc = parsePositiveNumber(process.env.FUZZ_AMOUNT_BTC, 0.00001);
const candidateShapes = parseFuzzCandidateShapes(
  process.env.FUZZ_CANDIDATE_SHAPES,
);

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
  async submitRawTransaction(rawTx: string) {
    const response = await fetch(`${bouncerUrl}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawTx }),
    });

    const body = (await response.json()) as unknown;

    if (!response.ok) {
      throw new Error(
        `Bouncer submit failed with HTTP ${response.status}: ${JSON.stringify(body)}`,
      );
    }

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

for (const result of results) {
  console.log(JSON.stringify(result));
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
