export type TxSummary = {
  txid: string;
  vsize: number;
  weight: number;
  inputs: number;
  outputs: number;
  outputScripts: string[];
  outputValuesSats: number[];
};

export type PreflightCheck =
  | {
      allowed: true;
      feeRateSatVb?: number;
    }
  | {
      allowed: false;
      rejectReason: string;
    };

export type AgentAction =
  | { action: "pass"; reason?: string }
  | { action: "hold"; reason: string }
  | { action: "drop"; reason: string }
  | { action: "shadow_drop"; reason: string }
  | { action: "tag"; label: string };

export type GateNode = {
  summarize(rawTx: string): Promise<TxSummary>;
  preflight(rawTx: string): Promise<PreflightCheck>;
  submit(rawTx: string): Promise<{ txid: string }>;
};

export type LiveAgent = {
  decide(input: {
    rawTx: string;
    summary: TxSummary;
    preflight: PreflightCheck & { allowed: true };
  }): Promise<AgentAction>;
};

export type BouncerStateStore = {
  findIdempotencyRecord(
    txid: string,
  ):
    | Promise<{ httpStatus: number; responseBody: unknown } | undefined>
    | { httpStatus: number; responseBody: unknown }
    | undefined;
  rememberIdempotencyRecord(input: {
    txid: string;
    httpStatus: number;
    responseBody: unknown;
  }): Promise<void> | void;
  recordAuditEvent(input: {
    txid: string;
    outcome: string;
    responseBody: unknown;
  }): Promise<void> | void;
  recordTag(input: {
    txid: string;
    label: string;
    summary: TxSummary;
  }): Promise<void> | void;
  hold(input: {
    rawTx: string;
    txid: string;
    reason: string;
    summary: TxSummary;
  }): Promise<{ holdId: string }> | { holdId: string };
  shadowDrop(input: {
    rawTx: string;
    txid: string;
    reason: string;
    summary: TxSummary;
  }): Promise<void> | void;
  reset(): Promise<void> | void;
};
