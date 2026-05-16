import { describe, expect, it, vi } from "vitest";
import {
  parseFuzzCandidateShapes,
  runFuzzCandidates,
} from "../src/fuzz-candidate-runner.js";

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
        shape: "standard-single-output",
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

  it("creates a standard multi-output Fuzz Candidate when requested", async () => {
    const wallet = {
      getNewAddress: vi
        .fn()
        .mockResolvedValueOnce("bcrt1qrecipient1")
        .mockResolvedValueOnce("bcrt1qrecipient2"),
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
    };
    const bouncer = {
      submitRawTransaction: vi.fn().mockResolvedValue({ txid: "abc123" }),
    };

    await runFuzzCandidates({
      wallet,
      bouncer,
      count: 1,
      amountBtc: 0.00001,
      candidateShapes: ["standard-multi-output"],
    });

    expect(wallet.walletCreateFundedPsbt).toHaveBeenCalledWith(
      [],
      [{ bcrt1qrecipient1: 0.00001 }, { bcrt1qrecipient2: 0.00001 }],
      0,
      { replaceable: true },
      true,
    );
  });

  it("creates an RBF-disabled Fuzz Candidate when requested", async () => {
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
    };
    const bouncer = {
      submitRawTransaction: vi.fn().mockResolvedValue({ txid: "abc123" }),
    };

    await runFuzzCandidates({
      wallet,
      bouncer,
      count: 1,
      amountBtc: 0.00001,
      candidateShapes: ["rbf-disabled"],
    });

    expect(wallet.walletCreateFundedPsbt).toHaveBeenCalledWith(
      [],
      [{ bcrt1qrecipient: 0.00001 }],
      0,
      { replaceable: false },
      true,
    );
  });

  it("creates a tiny-output Fuzz Candidate when requested", async () => {
    const wallet = {
      getNewAddress: vi.fn().mockResolvedValue("bcrt1qtiny"),
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
    };
    const bouncer = {
      submitRawTransaction: vi.fn().mockResolvedValue({ txid: "abc123" }),
    };

    await runFuzzCandidates({
      wallet,
      bouncer,
      count: 1,
      amountBtc: 0.00001,
      candidateShapes: ["tiny-output"],
    });

    expect(wallet.walletCreateFundedPsbt).toHaveBeenCalledWith(
      [],
      [{ bcrt1qtiny: 0.00000546 }],
      0,
      { replaceable: true },
      true,
    );
  });

  it("creates a Sub-1-Sat/VB Candidate when requested", async () => {
    const wallet = {
      getNewAddress: vi.fn().mockResolvedValue("bcrt1qlowfee"),
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
    };
    const bouncer = {
      submitRawTransaction: vi.fn().mockResolvedValue({ txid: "abc123" }),
    };

    await runFuzzCandidates({
      wallet,
      bouncer,
      count: 1,
      amountBtc: 0.00001,
      candidateShapes: ["sub-1-sat-vb-fee"],
    });

    expect(wallet.walletCreateFundedPsbt).toHaveBeenCalledWith(
      [],
      [{ bcrt1qlowfee: 0.00001 }],
      0,
      {
        replaceable: true,
        fee_rate: 0.5,
      },
      true,
    );
  });

  it("parses configured Fuzz Candidate shapes from a comma-separated list", () => {
    expect(
      parseFuzzCandidateShapes(
        "standard-single-output,standard-multi-output,tiny-output,rbf-enabled,rbf-disabled,sub-1-sat-vb-fee",
      ),
    ).toEqual([
      "standard-single-output",
      "standard-multi-output",
      "tiny-output",
      "rbf-enabled",
      "rbf-disabled",
      "sub-1-sat-vb-fee",
    ]);
  });

  it("cycles named Fuzz Candidate shapes across a batch", async () => {
    const wallet = {
      getNewAddress: vi
        .fn()
        .mockResolvedValueOnce("bcrt1qfirst")
        .mockResolvedValueOnce("bcrt1qsecond")
        .mockResolvedValueOnce("bcrt1qthird"),
      walletCreateFundedPsbt: vi
        .fn()
        .mockResolvedValueOnce({ psbt: "funded-psbt-1" })
        .mockResolvedValueOnce({ psbt: "funded-psbt-2" })
        .mockResolvedValueOnce({ psbt: "funded-psbt-3" }),
      walletProcessPsbt: vi
        .fn()
        .mockResolvedValueOnce({ psbt: "signed-psbt-1" })
        .mockResolvedValueOnce({ psbt: "signed-psbt-2" })
        .mockResolvedValueOnce({ psbt: "signed-psbt-3" }),
      finalizePsbt: vi
        .fn()
        .mockResolvedValueOnce({ hex: "rawtx-1", complete: true })
        .mockResolvedValueOnce({ hex: "rawtx-2", complete: true })
        .mockResolvedValueOnce({ hex: "rawtx-3", complete: true }),
    };
    const bouncer = {
      submitRawTransaction: vi
        .fn()
        .mockResolvedValueOnce({ txid: "txid-1" })
        .mockResolvedValueOnce({ txid: "txid-2" })
        .mockResolvedValueOnce({ txid: "txid-3" }),
    };

    await expect(
      runFuzzCandidates({
        wallet,
        bouncer,
        count: 3,
        amountBtc: 0.00001,
        candidateShapes: ["standard-single-output", "tiny-output"],
      }),
    ).resolves.toEqual([
      {
        shape: "standard-single-output",
        rawTx: "rawtx-1",
        response: { txid: "txid-1" },
      },
      {
        shape: "tiny-output",
        rawTx: "rawtx-2",
        response: { txid: "txid-2" },
      },
      {
        shape: "standard-single-output",
        rawTx: "rawtx-3",
        response: { txid: "txid-3" },
      },
    ]);
  });
});
