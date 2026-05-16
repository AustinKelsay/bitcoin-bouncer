import type { GateNode, PreflightCheck, TxSummary } from "./domain.js";

type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

type DecodedTransaction = {
  txid: string;
  vsize: number;
  weight: number;
  vin: unknown[];
  vout: Array<{
    value: number;
    scriptPubKey?: {
      type?: string;
    };
  }>;
};

type TestMempoolAcceptResult = {
  allowed: boolean;
  "reject-reason"?: string;
  rejectReason?: string;
  fees?: {
    base?: number;
  };
  vsize?: number;
};

const scriptTypeLabels: Record<string, string> = {
  witness_v1_taproot: "p2tr",
  witness_v0_keyhash: "p2wpkh",
  witness_v0_scripthash: "p2wsh",
  nulldata: "op_return",
  pubkeyhash: "p2pkh",
  scripthash: "p2sh",
};

export class BitcoinCoreGateNode implements GateNode {
  readonly #rpc: RpcCall;

  constructor(dependencies: { rpc: RpcCall }) {
    this.#rpc = dependencies.rpc;
  }

  async summarize(rawTx: string): Promise<TxSummary> {
    const decoded = (await this.#rpc("decoderawtransaction", [
      rawTx,
    ])) as DecodedTransaction;

    return {
      txid: decoded.txid,
      vsize: decoded.vsize,
      weight: decoded.weight,
      inputs: decoded.vin.length,
      outputs: decoded.vout.length,
      outputScripts: decoded.vout.map((output) =>
        normalizeScriptType(output.scriptPubKey?.type),
      ),
      outputValuesSats: decoded.vout.map((output) =>
        Math.round(output.value * 100_000_000),
      ),
    };
  }

  async preflight(rawTx: string): Promise<PreflightCheck> {
    const [result] = (await this.#rpc("testmempoolaccept", [
      [rawTx],
    ])) as TestMempoolAcceptResult[];

    if (!result.allowed) {
      return {
        allowed: false,
        rejectReason:
          result["reject-reason"] ?? result.rejectReason ?? "preflight rejected",
      };
    }

    return {
      allowed: true,
      feeRateSatVb: feeRateSatVb(result),
    };
  }

  async submit(rawTx: string): Promise<{ txid: string }> {
    const txid = (await this.#rpc("sendrawtransaction", [rawTx])) as string;
    return { txid };
  }
}

function normalizeScriptType(type: string | undefined): string {
  if (!type) {
    return "unknown";
  }

  return scriptTypeLabels[type] ?? type;
}

function feeRateSatVb(result: TestMempoolAcceptResult): number | undefined {
  if (!result.fees?.base || !result.vsize) {
    return undefined;
  }

  return (result.fees.base * 100_000_000) / result.vsize;
}
