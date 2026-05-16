#!/usr/bin/env tsx
import { BitcoinCoreObservationNode } from "../src/bitcoin-core-gate-node.js";
import { createBitcoinCoreRpc } from "../src/bitcoin-core-rpc.js";
import { scanGateNodeBlocksForShadowEscapes } from "../src/shadow-escape-monitor.js";
import { createSqliteBouncerStateStore } from "../src/sqlite-state-store.js";

const fromHeight = parseBlockHeight(requireEnv("FROM_HEIGHT"), "FROM_HEIGHT");
const toHeight = parseBlockHeight(
  process.env.TO_HEIGHT ?? String(fromHeight),
  "TO_HEIGHT",
);

if (toHeight < fromHeight) {
  throw new Error("TO_HEIGHT must be greater than or equal to FROM_HEIGHT");
}

const gateNode = new BitcoinCoreObservationNode({
  name: process.env.BITCOIN_GATE_NODE_NAME ?? "backend1",
  rpc: createBitcoinCoreRpc({
    url: process.env.BITCOIN_RPC_URL ?? "http://127.0.0.1:18443",
    username: process.env.BITCOIN_RPC_USER ?? "polaruser",
    password: process.env.BITCOIN_RPC_PASSWORD ?? "polarpass",
  }),
});
const stateStore = createSqliteBouncerStateStore({
  databasePath: process.env.BOUNCER_STATE_DB_PATH ?? "state/bouncer.sqlite",
});

try {
  const result = await scanGateNodeBlocksForShadowEscapes({
    blockSource: gateNode,
    stateStore,
    fromHeight,
    toHeight,
  });

  console.log(JSON.stringify(result, null, 2));
} finally {
  stateStore.close();
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseBlockHeight(value: string, name: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return parsed;
}
