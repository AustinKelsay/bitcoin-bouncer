import type {
  AgentAction,
  DeepTransactionView,
  LiveAgent,
  PreflightCheck,
  TxSummary,
} from "./domain.js";

type PiAgentAction = AgentAction | { action: "peek" } | unknown;

export type PiAgentClient = {
  decide(input: {
    prompt: string;
    promptHash: string;
    transaction: {
      rawTx: string;
      summary: TxSummary;
      preflight: PreflightCheck & { allowed: true };
    };
    deepTransactionView?: DeepTransactionView;
  }): Promise<PiAgentAction>;
};

export function createPiLiveAgentAdapter(input: {
  client: PiAgentClient;
  prompt: string;
  promptHash: string;
  peek: (input: {
    rawTx: string;
    summary: TxSummary;
    preflight: PreflightCheck & { allowed: true };
  }) => Promise<DeepTransactionView>;
  timeoutMs: number;
}): LiveAgent {
  return {
    async decide(transaction) {
      return withTimeout(
        decideWithPi({
          ...input,
          transaction,
        }),
        input.timeoutMs,
      ).catch((error) =>
        fallbackPass(error instanceof LiveAgentFallback ? error.reason : "timeout"),
      );
    },
  };
}

async function decideWithPi(input: {
  client: PiAgentClient;
  prompt: string;
  promptHash: string;
  peek: (transaction: {
    rawTx: string;
    summary: TxSummary;
    preflight: PreflightCheck & { allowed: true };
  }) => Promise<DeepTransactionView>;
  transaction: {
    rawTx: string;
    summary: TxSummary;
    preflight: PreflightCheck & { allowed: true };
  };
}): Promise<AgentAction> {
  const firstAction = await input.client.decide({
    prompt: input.prompt,
    promptHash: input.promptHash,
    transaction: input.transaction,
    deepTransactionView: undefined,
  });

  if (isPeekAction(firstAction)) {
    const deepTransactionView = await input.peek(input.transaction);
    const finalAction = await input.client.decide({
      prompt: input.prompt,
      promptHash: input.promptHash,
      transaction: input.transaction,
      deepTransactionView,
    });

    if (isPeekAction(finalAction)) {
      throw new LiveAgentFallback("tool_limit_violation");
    }

    return validateFinalAction(finalAction);
  }

  return validateFinalAction(firstAction);
}

function validateFinalAction(action: PiAgentAction): AgentAction {
  if (!isRecord(action) || typeof action.action !== "string") {
    throw new LiveAgentFallback("malformed_action");
  }

  if (action.action === "pass") {
    return typeof action.reason === "string"
      ? { action: "pass", reason: action.reason }
      : { action: "pass" };
  }

  if (
    (action.action === "hold" ||
      action.action === "drop" ||
      action.action === "shadow_drop") &&
    typeof action.reason === "string" &&
    action.reason.length > 0
  ) {
    return { action: action.action, reason: action.reason };
  }

  if (
    action.action === "tag" &&
    typeof action.label === "string" &&
    action.label.length > 0
  ) {
    return { action: "tag", label: action.label };
  }

  throw new LiveAgentFallback("malformed_action");
}

function isPeekAction(action: PiAgentAction): action is { action: "peek" } {
  return isRecord(action) && action.action === "peek";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function fallbackPass(reason: string): AgentAction {
  return {
    action: "pass",
    reason: `live_agent_fallback: ${reason}`,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new LiveAgentFallback("timeout")),
      timeoutMs,
    );

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

class LiveAgentFallback extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}
