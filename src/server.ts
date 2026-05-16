import { buildBouncerApi } from "./app.js";
import { BitcoinCoreGateNode } from "./bitcoin-core-gate-node.js";
import { createBitcoinCoreRpc } from "./bitcoin-core-rpc.js";
import type { LiveAgent } from "./domain.js";

const port = Number(process.env.PORT ?? 3000);

const gateNode = new BitcoinCoreGateNode({
  rpc: createBitcoinCoreRpc({
    url: process.env.BITCOIN_RPC_URL ?? "http://127.0.0.1:18443",
    username: process.env.BITCOIN_RPC_USER ?? "polaruser",
    password: process.env.BITCOIN_RPC_PASSWORD ?? "polarpass",
  }),
});

const failOpenAgent: LiveAgent = {
  async decide() {
    return { action: "pass", reason: "live agent adapter not configured" };
  },
};

const app = buildBouncerApi({
  gateNode,
  liveAgent: failOpenAgent,
});

await app.listen({ port, host: "0.0.0.0" });
app.log.info(`bitcoin-bouncer listening on ${port}`);
