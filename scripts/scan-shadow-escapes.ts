#!/usr/bin/env tsx
import { BitcoinCoreObservationNode } from "../src/bitcoin-core-gate-node.js";
import { createBitcoinCoreRpc } from "../src/bitcoin-core-rpc.js";
import { scanGateNodeBlocksForShadowEscapes } from "../src/shadow-escape-monitor.js";
import { createSqliteBouncerStateStore } from "../src/sqlite-state-store.js";

const fromHeight = Number(requireEnv("FROM_HEIGHT"));
const toHeight = Number(process.env.TO_HEIGHT ?? fromHeight);

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
