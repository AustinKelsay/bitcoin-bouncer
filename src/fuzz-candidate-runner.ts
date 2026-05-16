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

export type FuzzCandidateShape =
  | "standard-single-output"
  | "standard-multi-output"
  | "tiny-output"
  | "rbf-enabled"
  | "rbf-disabled"
  | "sub-1-sat-vb-fee";

const fuzzCandidateShapes = new Set<string>([
  "standard-single-output",
  "standard-multi-output",
  "tiny-output",
  "rbf-enabled",
  "rbf-disabled",
  "sub-1-sat-vb-fee",
]);

export function parseFuzzCandidateShapes(
  value: string | undefined,
): FuzzCandidateShape[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  return value.split(",").map((rawShape) => {
    const shape = rawShape.trim();

    if (!fuzzCandidateShapes.has(shape)) {
      throw new Error(`Unknown Fuzz Candidate shape: ${rawShape}`);
    }

    return shape as FuzzCandidateShape;
  });
}

export async function runFuzzCandidates(input: {
  wallet: FuzzCandidateWallet;
  bouncer: BouncerSubmitClient;
  count: number;
  amountBtc: number;
  candidateShapes?: FuzzCandidateShape[];
}): Promise<
  Array<{ shape: FuzzCandidateShape; rawTx: string; response: unknown }>
> {
  const results: Array<{
    shape: FuzzCandidateShape;
    rawTx: string;
    response: unknown;
  }> = [];
  const candidateShapes = input.candidateShapes ?? ["standard-single-output"];

  for (let index = 0; index < input.count; index += 1) {
    const shape = candidateShapes[index % candidateShapes.length];
    const outputs = await buildOutputs({
      wallet: input.wallet,
      shape,
      amountBtc: input.amountBtc,
    });
    const funded = await input.wallet.walletCreateFundedPsbt(
      [],
      outputs,
      0,
      fundingOptions(shape),
      true,
    );
    const signed = await input.wallet.walletProcessPsbt(funded.psbt);
    const finalized = await input.wallet.finalizePsbt(signed.psbt);

    if (!finalized.complete) {
      throw new Error("Unable to finalize wallet-funded Fuzz Candidate");
    }

    results.push({
      shape,
      rawTx: finalized.hex,
      response: await input.bouncer.submitRawTransaction(finalized.hex),
    });
  }

  return results;
}

function fundingOptions(shape: FuzzCandidateShape) {
  const options: Record<string, unknown> = {
    replaceable: shape !== "rbf-disabled",
  };

  if (shape === "sub-1-sat-vb-fee") {
    options.fee_rate = 0.5;
  }

  return options;
}

async function buildOutputs(input: {
  wallet: FuzzCandidateWallet;
  shape: FuzzCandidateShape;
  amountBtc: number;
}) {
  const outputAmountBtc =
    input.shape === "tiny-output" ? 0.00000546 : input.amountBtc;

  if (input.shape === "standard-multi-output") {
    const firstAddress = await input.wallet.getNewAddress();
    const secondAddress = await input.wallet.getNewAddress();

    return [
      { [firstAddress]: outputAmountBtc },
      { [secondAddress]: outputAmountBtc },
    ];
  }

  const address = await input.wallet.getNewAddress();
  return [{ [address]: outputAmountBtc }];
}
