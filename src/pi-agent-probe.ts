import type { PiAgentClient } from "./pi-live-agent-adapter.js";

export function createPiAgentProbeRequest() {
  return {
    prompt:
      "You are the Live Agent for Bitcoin Bouncer. Return one structured Agent Action.",
    promptHash: "sha256:probe",
    transaction: {
      rawTx: "020000000001...",
      summary: {
        txid: "probe-txid",
        vsize: 188,
        weight: 749,
        inputs: 1,
        outputs: 2,
        outputScripts: ["p2tr", "op_return"],
        outputValuesSats: [546, 0],
      },
      preflight: {
        allowed: true as const,
        feeRateSatVb: 0.4,
      },
    },
    deepTransactionView: undefined,
  };
}

export async function probePiAgent(input: {
  client: PiAgentClient;
}): Promise<unknown> {
  return input.client.decide(createPiAgentProbeRequest());
}
