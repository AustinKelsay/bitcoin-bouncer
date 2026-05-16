import { buildBouncerApi } from "./app.js";
import { BitcoinCoreGateNode } from "./bitcoin-core-gate-node.js";
import { createBitcoinCoreRpc } from "./bitcoin-core-rpc.js";
import type { LiveAgent } from "./domain.js";
import { createOpenAiCompatibleModelClient } from "./openai-compatible-model-client.js";
import { createPiLiveAgentAdapter } from "./pi-live-agent-adapter.js";
import {
  loadBouncerRuntimeConfig,
  saveBouncerPromptFile,
} from "./runtime-config.js";
import { createSqliteBouncerStateStore } from "./sqlite-state-store.js";

const port = Number(process.env.PORT ?? 3000);
let runtimeConfig;

try {
  runtimeConfig = await loadBouncerRuntimeConfig(process.env);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to load Bouncer runtime config: ${message}`);
  process.exit(1);
}

const gateNode = new BitcoinCoreGateNode({
  rpc: createBitcoinCoreRpc({
    url: runtimeConfig.gateNode.rpc.url,
    username: runtimeConfig.gateNode.rpc.username,
    password: runtimeConfig.gateNode.rpc.password,
  }),
});
const activePrompt = {
  content: runtimeConfig.prompt.content,
  hash: runtimeConfig.prompt.hash,
};

const liveAgent: LiveAgent = runtimeConfig.forcedAction
  ? {
      async decide() {
        return runtimeConfig.forcedAction!;
      },
    }
  : runtimeConfig.model
    ? createPiLiveAgentAdapter({
        model: createOpenAiCompatibleModelClient({
          baseUrl: runtimeConfig.model.baseUrl,
          apiKey: runtimeConfig.model.apiKey,
          model: runtimeConfig.model.name,
        }),
        getPrompt: () => activePrompt,
        timeoutMs: runtimeConfig.model.timeoutMs,
        async peek(transaction) {
          return {
            txid: transaction.summary.txid,
            rawTx: transaction.rawTx,
            summary: transaction.summary,
            preflight: transaction.preflight,
          };
        },
      })
  : {
      async decide() {
        return { action: "pass", reason: "live agent adapter not configured" };
      },
    };

const app = buildBouncerApi({
  gateNode,
  liveAgent,
  stateStore: createSqliteBouncerStateStore({
    databasePath: runtimeConfig.state.databasePath,
  }),
  runtime: {
    prompt: activePrompt.content,
    promptHash: activePrompt.hash,
    gateNodeName: runtimeConfig.gateNode.name,
    propagationWitnessNames: runtimeConfig.propagationWitnesses.map(
      (witness) => witness.name,
    ),
  },
  savePrompt: async (prompt) => {
    const saved = await saveBouncerPromptFile(runtimeConfig.prompt.path, prompt);
    activePrompt.content = saved.prompt;
    activePrompt.hash = saved.promptHash;

    return saved;
  },
  decisionQueue: {
    maxPending: runtimeConfig.decisionQueue.maxPending,
  },
});

await app.listen({ port, host: "0.0.0.0" });
app.log.info(
  {
    promptHash: runtimeConfig.prompt.hash,
    gateNode: runtimeConfig.gateNode.name,
    propagationWitnesses: runtimeConfig.propagationWitnesses.map(
      (witness) => witness.name,
    ),
  },
  `bitcoin-bouncer listening on ${port}`,
);
