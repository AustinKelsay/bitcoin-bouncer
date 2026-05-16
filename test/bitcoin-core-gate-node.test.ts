import { describe, expect, it, vi } from "vitest";
import {
  BitcoinCoreGateNode,
  BitcoinCoreObservationNode,
} from "../src/bitcoin-core-gate-node.js";

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
          scriptPubKey: {
            type: "nulldata",
            asm: `OP_RETURN ${Buffer.from("BOUNCER_FUZZ_DIRECTIVE=drop", "utf8").toString("hex")}`,
          },
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
      opReturnUtf8: ["BOUNCER_FUZZ_DIRECTIVE=drop"],
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

describe("Bitcoin Core observation node adapter", () => {
  it("reads block txids by height for Shadow Escape monitoring", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce("000000000000000000abc")
      .mockResolvedValueOnce({
        hash: "000000000000000000abc",
        height: 101,
        tx: ["coinbase", "abc123"],
      });
    const node = new BitcoinCoreObservationNode({ name: "backend1", rpc });

    await expect(node.getBlockByHeight(101)).resolves.toEqual({
      hash: "000000000000000000abc",
      height: 101,
      txids: ["coinbase", "abc123"],
    });
    expect(rpc).toHaveBeenCalledWith("getblockhash", [101]);
    expect(rpc).toHaveBeenCalledWith("getblock", [
      "000000000000000000abc",
      1,
    ]);
  });

  it("checks mempool visibility for Propagation Witness verification", async () => {
    const rpc = vi.fn().mockResolvedValue({});
    const node = new BitcoinCoreObservationNode({ name: "backend2", rpc });

    await expect(node.hasTransactionInMempool("abc123")).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("getmempoolentry", ["abc123"]);
  });

  it("treats Bitcoin Core mempool misses as absent transactions", async () => {
    const rpc = vi
      .fn()
      .mockRejectedValue(new Error("Transaction not in mempool"));
    const node = new BitcoinCoreObservationNode({ name: "backend2", rpc });

    await expect(node.hasTransactionInMempool("abc123")).resolves.toBe(false);
  });
});
