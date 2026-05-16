export type FuzzCandidateWallet = {
  getNewAddress(): Promise<string>;
  walletCreateFundedPsbt(
    inputs: unknown[],
    outputs: Array<Record<string, number>>,
    locktime: number,
    options: Record<string, unknown>,
    bip32derivs: boolean,
  ): Promise<{ psbt: string }>;
  walletProcessPsbt(psbt: string): Promise<{ psbt: string }>;
  finalizePsbt(psbt: string): Promise<{ hex: string; complete: boolean }>;
};

export type BouncerSubmitClient = {
  submitRawTransaction(rawTx: string): Promise<unknown>;
};

export async function runFuzzCandidates(input: {
  wallet: FuzzCandidateWallet;
  bouncer: BouncerSubmitClient;
  count: number;
  amountBtc: number;
}): Promise<Array<{ rawTx: string; response: unknown }>> {
  const results: Array<{ rawTx: string; response: unknown }> = [];

  for (let index = 0; index < input.count; index += 1) {
    const address = await input.wallet.getNewAddress();
    const funded = await input.wallet.walletCreateFundedPsbt(
      [],
      [{ [address]: input.amountBtc }],
      0,
      { replaceable: true },
      true,
    );
    const signed = await input.wallet.walletProcessPsbt(funded.psbt);
    const finalized = await input.wallet.finalizePsbt(signed.psbt);

    if (!finalized.complete) {
      throw new Error("Unable to finalize wallet-funded Fuzz Candidate");
    }

    results.push({
      rawTx: finalized.hex,
      response: await input.bouncer.submitRawTransaction(finalized.hex),
    });
  }

  return results;
}
