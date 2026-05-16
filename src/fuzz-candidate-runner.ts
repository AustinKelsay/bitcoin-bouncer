export type FuzzCandidateWallet = {
  getNewAddress(): Promise<string>;
  walletCreateFundedPsbt(
    inputs: unknown[],
    outputs: Array<Record<string, number | string>>,
    locktime: number,
    options: Record<string, unknown>,
    bip32derivs: boolean,
  ): Promise<{ psbt: string }>;
  walletProcessPsbt(psbt: string): Promise<{ psbt: string }>;
  finalizePsbt(psbt: string): Promise<{ hex: string; complete: boolean }>;
};

export type BouncerSubmitClient = {
  submitRawTransaction(
    rawTx: string,
    context: FuzzCandidateContext,
  ): Promise<unknown>;
};

export type FuzzCandidateShape =
  | "standard-single-output"
  | "standard-multi-output"
  | "tiny-output"
  | "rbf-enabled"
  | "rbf-disabled"
  | "sub-1-sat-vb-fee"
  | "ord-inscription-envelope"
  | "brc20-transfer"
  | "runes-etching"
  | "runes-transfer"
  | "stamps-metadata"
  | "high-fanout";

export const allFuzzCandidateShapes = [
  "standard-single-output",
  "standard-multi-output",
  "tiny-output",
  "rbf-enabled",
  "rbf-disabled",
  "sub-1-sat-vb-fee",
  "ord-inscription-envelope",
  "brc20-transfer",
  "runes-etching",
  "runes-transfer",
  "stamps-metadata",
  "high-fanout",
] as const satisfies readonly FuzzCandidateShape[];

export type FuzzCandidateContext = {
  shape: FuzzCandidateShape;
  index: number;
  count: number;
};

const fuzzCandidateShapes = new Set<string>(allFuzzCandidateShapes);

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

    const context = { shape, index, count: input.count };

    results.push({
      shape,
      rawTx: finalized.hex,
      response: await input.bouncer.submitRawTransaction(finalized.hex, context),
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

  if (input.shape === "high-fanout") {
    const addresses = await Promise.all(
      Array.from({ length: 8 }, () => input.wallet.getNewAddress()),
    );

    return addresses.map((address) => ({ [address]: outputAmountBtc }));
  }

  if (input.shape === "ord-inscription-envelope") {
    return [
      { data: textToHex("ord\x01text/plain;charset=utf-8\x00bitcoin-bouncer") },
      { [await input.wallet.getNewAddress()]: outputAmountBtc },
    ];
  }

  if (input.shape === "brc20-transfer") {
    return [
      {
        data: textToHex(
          [
            JSON.stringify({
              p: "brc-20",
              op: "transfer",
              tick: "ordi",
              amt: "1000",
            }),
            "BOUNCER_FUZZ_DIRECTIVE=drop",
            "reason=brc20 transfer metadata local fuzz withholding demo",
          ].join(";"),
        ),
      },
      { [await input.wallet.getNewAddress()]: outputAmountBtc },
    ];
  }

  if (input.shape === "runes-etching") {
    return [
      { data: textToHex("RUNES:ETCH:BOUNCER•FUZZ:premine=0:terms=open") },
      { [await input.wallet.getNewAddress()]: outputAmountBtc },
    ];
  }

  if (input.shape === "runes-transfer") {
    return [
      { data: textToHex("RUNES:XFER:BOUNCER•FUZZ:1") },
      { [await input.wallet.getNewAddress()]: outputAmountBtc },
    ];
  }

  if (input.shape === "stamps-metadata") {
    return [
      {
        data: textToHex(
          [
            "STAMP:base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
            "BOUNCER_FUZZ_DIRECTIVE=shadow_drop",
            "reason=stamp metadata local fuzz shadow demo",
          ].join(";"),
        ),
      },
      { [await input.wallet.getNewAddress()]: outputAmountBtc },
    ];
  }

  const address = await input.wallet.getNewAddress();
  return [{ [address]: outputAmountBtc }];
}

function textToHex(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}
