#!/usr/bin/env tsx
import { BitcoinCoreObservationNode } from "../src/bitcoin-core-gate-node.js";
import { createBitcoinCoreRpc } from "../src/bitcoin-core-rpc.js";
import {
  type PropagationExpectation,
  verifyPropagation,
} from "../src/propagation-verifier.js";

const txid = requireEnv("TXID");
const expected = parseExpectation(process.env.EXPECTED ?? "present");
const gateNodeName = process.env.BITCOIN_GATE_NODE_NAME ?? "backend1";

const gateNode = new BitcoinCoreObservationNode({
  name: gateNodeName,
  rpc: createBitcoinCoreRpc({
    url: process.env.BITCOIN_RPC_URL ?? "http://127.0.0.1:18443",
    username: process.env.BITCOIN_RPC_USER ?? "polaruser",
    password: process.env.BITCOIN_RPC_PASSWORD ?? "polarpass",
  }),
});

const propagationWitnesses = parseWitnesses(
  process.env.BITCOIN_PROPAGATION_WITNESSES,
).map(
  (witness) =>
    new BitcoinCoreObservationNode({
      name: witness.name,
      rpc: createBitcoinCoreRpc({
        url: witness.rpcUrl,
        username: process.env.BITCOIN_RPC_USER ?? "polaruser",
        password: process.env.BITCOIN_RPC_PASSWORD ?? "polarpass",
      }),
    }),
);

const result = await verifyPropagation({
  txid,
  expected,
  gateNode,
  propagationWitnesses,
});

console.log(JSON.stringify(result, null, 2));
process.exitCode = result.passed ? 0 : 1;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseExpectation(value: string): PropagationExpectation {
  if (value === "present" || value === "absent") {
    return value;
  }

  throw new Error("EXPECTED must be present or absent");
}

function parseWitnesses(value: string | undefined) {
  if (!value) {
    return [];
  }

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
