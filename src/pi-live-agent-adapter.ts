import type {
  AgentAction,
  DeepTransactionView,
  LiveAgent,
  PreflightCheck,
  TxSummary,
} from "./domain.js";

type PiToolName = AgentAction["action"] | "peek";

export type PiToolCall = {
  name: string;
  arguments?: unknown;
};

export type PiModelClient = {
  complete(input: {
    prompt: string;
    promptHash: string;
    transaction: PiTransactionContext;
    deepTransactionView?: DeepTransactionView;
    tools: PiToolDefinition[];
  }): Promise<{ toolCall?: PiToolCall }>;
};

export type PiToolDefinition = {
  name: PiToolName;
  description: string;
  parameters: Record<string, unknown>;
};

type PiTransactionContext = {
  rawTx: string;
  summary: TxSummary;
  preflight: PreflightCheck & { allowed: true };
};

const MODEL_RAW_TX_PREVIEW_CHARS = 512;

export function createPiLiveAgentAdapter(input: {
  model: PiModelClient;
  prompt?: string;
  promptHash?: string;
  getPrompt?: () => { content: string; hash: string };
  peek: (input: {
    rawTx: string;
    summary: TxSummary;
    preflight: PreflightCheck & { allowed: true };
  }) => Promise<DeepTransactionView>;
  timeoutMs: number;
}): LiveAgent {
  return {
    async decide(transaction) {
      const prompt = input.getPrompt?.() ?? {
        content: input.prompt ?? "",
        hash: input.promptHash ?? "",
      };

      return withTimeout(
        decideWithPi({
          ...input,
          prompt: prompt.content,
          promptHash: prompt.hash,
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
  model: PiModelClient;
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
  const modelTransaction = modelTransactionContext(input.transaction);
  const firstAction = await input.model.complete({
    prompt: input.prompt,
    promptHash: input.promptHash,
    transaction: modelTransaction,
    deepTransactionView: undefined,
    tools: firstTurnTools(),
  });
  const firstToolCall = firstAction.toolCall;

  if (!firstToolCall) {
    throw new LiveAgentFallback("no_final_action");
  }

  if (firstToolCall.name === "peek") {
    const deepTransactionView = modelDeepTransactionView(
      await input.peek(input.transaction),
    );
    const finalAction = await input.model.complete({
      prompt: input.prompt,
      promptHash: input.promptHash,
      transaction: modelTransaction,
      deepTransactionView,
      tools: terminalTools(),
    });
    const finalToolCall = finalAction.toolCall;

    if (!finalToolCall) {
      throw new LiveAgentFallback("no_final_action");
    }

    if (finalToolCall.name === "peek") {
      throw new LiveAgentFallback("tool_limit_violation");
    }

    return validateFinalToolCall(finalToolCall);
  }

  return validateFinalToolCall(firstToolCall);
}

function modelTransactionContext(
  transaction: PiTransactionContext,
): PiTransactionContext {
  return {
    ...transaction,
    rawTx: rawTxPreview(transaction.rawTx),
  };
}

function modelDeepTransactionView(
  deepTransactionView: DeepTransactionView,
): DeepTransactionView {
  return {
    ...deepTransactionView,
    rawTx: rawTxPreview(deepTransactionView.rawTx),
  };
}

function rawTxPreview(rawTx: string): string {
  if (rawTx.length <= MODEL_RAW_TX_PREVIEW_CHARS) {
    return rawTx;
  }

  return `${rawTx.slice(0, MODEL_RAW_TX_PREVIEW_CHARS)}...<truncated ${
    rawTx.length - MODEL_RAW_TX_PREVIEW_CHARS
  } chars>`;
}

function validateFinalToolCall(toolCall: PiToolCall): AgentAction {
  if (typeof toolCall.name !== "string") {
    throw new LiveAgentFallback("malformed_action");
  }

  const args = isRecord(toolCall.arguments) ? toolCall.arguments : {};

  if (toolCall.name === "pass") {
    return typeof args.reason === "string"
      ? { action: "pass", reason: args.reason }
      : { action: "pass" };
  }

  if (
    (toolCall.name === "hold" ||
      toolCall.name === "drop" ||
      toolCall.name === "shadow_drop") &&
    typeof args.reason === "string" &&
    args.reason.length > 0
  ) {
    return { action: toolCall.name, reason: args.reason };
  }

  if (
    toolCall.name === "tag" &&
    typeof args.label === "string" &&
    args.label.length > 0
  ) {
    return { action: "tag", label: args.label };
  }

  throw new LiveAgentFallback("malformed_action");
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

function firstTurnTools(): PiToolDefinition[] {
  return [...terminalTools(), peekTool()];
}

function terminalTools(): PiToolDefinition[] {
  return [
    {
      name: "pass",
      description: "Allow the transaction through the Submission Gate.",
      parameters: optionalReasonParameters(),
    },
    {
      name: "tag",
      description: "Allow the transaction and attach an audit-only label.",
      parameters: requiredStringParameters("label"),
    },
    {
      name: "hold",
      description:
        "Withhold the transaction pending explicit operator release or discard.",
      parameters: requiredStringParameters("reason"),
    },
    {
      name: "drop",
      description: "Honestly withhold the transaction from the Gate Node.",
      parameters: requiredStringParameters("reason"),
    },
    {
      name: "shadow_drop",
      description:
        "Withhold the transaction while returning a txid-shaped success response.",
      parameters: requiredStringParameters("reason"),
    },
  ];
}

function peekTool(): PiToolDefinition {
  return {
    name: "peek",
    description:
      "Request one bounded Deep Transaction View before making a final action decision.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
}

function requiredStringParameters(name: string): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      [name]: { type: "string" },
    },
    required: [name],
    additionalProperties: false,
  };
}

function optionalReasonParameters(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      reason: { type: "string" },
    },
    additionalProperties: false,
  };
}
