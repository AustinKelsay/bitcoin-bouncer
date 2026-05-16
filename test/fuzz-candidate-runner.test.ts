import { describe, expect, it, vi } from "vitest";
import { runFuzzCandidates } from "../src/fuzz-candidate-runner.js";

describe("Fuzz Candidate runner", () => {
  it("creates signed wallet-funded raw transactions and submits them through Bouncer without direct broadcast", async () => {
    const wallet = {
      getNewAddress: vi.fn().mockResolvedValue("bcrt1qrecipient"),
      walletCreateFundedPsbt: vi.fn().mockResolvedValue({
        psbt: "funded-psbt",
      }),
      walletProcessPsbt: vi.fn().mockResolvedValue({
        psbt: "signed-psbt",
      }),
      finalizePsbt: vi.fn().mockResolvedValue({
        hex: "020000000001...",
        complete: true,
      }),
      sendRawTransaction: vi.fn(),
    };
    const bouncer = {
      submitRawTransaction: vi.fn().mockResolvedValue({ txid: "abc123" }),
    };

    await expect(
      runFuzzCandidates({
        wallet,
        bouncer,
        count: 1,
        amountBtc: 0.00001,
      }),
    ).resolves.toEqual([
      {
        rawTx: "020000000001...",
        response: { txid: "abc123" },
      },
    ]);
    expect(wallet.walletCreateFundedPsbt).toHaveBeenCalledWith(
      [],
      [{ bcrt1qrecipient: 0.00001 }],
      0,
      { replaceable: true },
      true,
    );
    expect(wallet.sendRawTransaction).not.toHaveBeenCalled();
    expect(bouncer.submitRawTransaction).toHaveBeenCalledWith(
      "020000000001...",
    );
  });
});
