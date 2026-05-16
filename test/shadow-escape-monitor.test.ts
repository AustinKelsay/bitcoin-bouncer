import { describe, expect, it, vi } from "vitest";
import { scanGateNodeBlocksForShadowEscapes } from "../src/shadow-escape-monitor.js";

describe("Shadow Escape monitor", () => {
  it("records Shadow Escape observations for mined Shadow Realm txids without rewriting the original record", async () => {
    const blockSource = {
      getBlockByHeight: vi.fn().mockResolvedValue({
        hash: "000000000000000000abc",
        height: 101,
        txids: ["coinbase", "shadowed-txid", "ordinary-txid"],
      }),
    };
    const stateStore = {
      findShadowDrop: vi.fn(async (txid: string) =>
        txid === "shadowed-txid"
          ? {
              txid,
              reason: "withheld from gate node",
              rawTx: "020000000001...",
              summary: {
                txid,
                vsize: 188,
                weight: 749,
                inputs: 1,
                outputs: 2,
                outputScripts: ["p2tr"],
                outputValuesSats: [546],
              },
            }
          : undefined,
      ),
      recordShadowEscape: vi.fn(),
      recordAuditEvent: vi.fn(),
    };

    await expect(
      scanGateNodeBlocksForShadowEscapes({
        blockSource,
        stateStore,
        fromHeight: 101,
        toHeight: 101,
      }),
    ).resolves.toEqual({
      scannedBlocks: 1,
      shadowEscapes: [
        {
          txid: "shadowed-txid",
          blockHash: "000000000000000000abc",
          blockHeight: 101,
        },
      ],
    });
    expect(stateStore.recordShadowEscape).toHaveBeenCalledWith({
      txid: "shadowed-txid",
      blockHash: "000000000000000000abc",
      blockHeight: 101,
    });
    expect(stateStore.recordAuditEvent).not.toHaveBeenCalled();
  });
});
