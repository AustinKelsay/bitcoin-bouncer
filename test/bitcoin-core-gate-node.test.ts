import { describe, expect, it, vi } from "vitest";
import { BitcoinCoreGateNode } from "../src/bitcoin-core-gate-node.js";

describe("Bitcoin Core Gate Node adapter", () => {
  it("summarizes a raw transaction from decoderawtransaction", async () => {
    const rpc = vi.fn().mockResolvedValue({
      txid: "abc123",
      vsize: 188,
      weight: 749,
      vin: [{ txid: "prev", vout: 0 }],
      vout: [
        {
          value: 0.00000546,
          scriptPubKey: { type: "witness_v1_taproot" },
        },
        {
          value: 0,
          scriptPubKey: { type: "nulldata" },
        },
      ],
    });
    const gateNode = new BitcoinCoreGateNode({ rpc });

    await expect(gateNode.summarize("020000000001...")).resolves.toEqual({
      txid: "abc123",
      vsize: 188,
      weight: 749,
      inputs: 1,
      outputs: 2,
      outputScripts: ["p2tr", "op_return"],
      outputValuesSats: [546, 0],
    });
    expect(rpc).toHaveBeenCalledWith("decoderawtransaction", [
      "020000000001...",
    ]);
  });

  it("runs testmempoolaccept as the preflight check", async () => {
    const rpc = vi.fn().mockResolvedValue([
      {
        txid: "abc123",
        allowed: true,
        fees: { base: 0.00000752 },
        vsize: 188,
      },
    ]);
    const gateNode = new BitcoinCoreGateNode({ rpc });

    await expect(gateNode.preflight("020000000001...")).resolves.toEqual({
      allowed: true,
      feeRateSatVb: 4,
    });
    expect(rpc).toHaveBeenCalledWith("testmempoolaccept", [
      ["020000000001..."],
    ]);
  });
});
