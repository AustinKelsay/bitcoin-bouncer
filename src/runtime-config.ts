import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export type BouncerRuntimeConfig = {
  prompt: {
    path: string;
    content: string;
    hash: string;
  };
  state: {
    databasePath: string;
  };
  gateNode: {
    name: string;
    rpc: {
      url: string;
      username: string;
      password: string;
    };
  };
  propagationWitnesses: Array<{
    name: string;
    rpcUrl: string;
  }>;
  piAgent?: {
    url: string;
    timeoutMs: number;
  };
};

type RuntimeEnvironment = Record<string, string | undefined>;

export async function loadBouncerRuntimeConfig(
  environment: RuntimeEnvironment,
): Promise<BouncerRuntimeConfig> {
  const promptPath = requireEnvironment(
    environment,
    "BOUNCER_PROMPT_PATH",
  );
  const promptContent = await readPromptFile(promptPath);
  const gateNodeName = requireEnvironment(
    environment,
    "BITCOIN_GATE_NODE_NAME",
  );
  const bitcoinRpcUrl = requireEnvironment(environment, "BITCOIN_RPC_URL");
  const bitcoinRpcUser = requireEnvironment(environment, "BITCOIN_RPC_USER");
  const bitcoinRpcPassword = requireEnvironment(
    environment,
    "BITCOIN_RPC_PASSWORD",
  );

  return {
    prompt: {
      path: promptPath,
      content: promptContent,
      hash: `sha256:${createHash("sha256").update(promptContent).digest("hex")}`,
    },
    state: {
      databasePath: environment.BOUNCER_STATE_DB_PATH ?? "state/bouncer.sqlite",
    },
    gateNode: {
      name: gateNodeName,
      rpc: {
        url: bitcoinRpcUrl,
        username: bitcoinRpcUser,
        password: bitcoinRpcPassword,
      },
    },
    propagationWitnesses: parsePropagationWitnesses(
      environment.BITCOIN_PROPAGATION_WITNESSES,
    ),
    piAgent: parsePiAgentConfig(environment),
  };
}

async function readPromptFile(promptPath: string): Promise<string> {
  try {
    return await readFile(promptPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to read Bouncer Prompt at ${promptPath}: ${message}`,
      { cause: error },
    );
  }
}

function requireEnvironment(
  environment: RuntimeEnvironment,
  name: string,
): string {
  const value = environment[name]?.trim();

  if (!value) {
    throw new Error(`Missing required runtime environment variable: ${name}`);
  }

  return value;
}

function parsePropagationWitnesses(
  value: string | undefined,
): BouncerRuntimeConfig["propagationWitnesses"] {
  if (!value) {
    return [];
  }

  return value.split(",").map((rawEntry) => {
    const entry = rawEntry.trim();
    const equalsIndex = entry.indexOf("=");

    if (equalsIndex <= 0 || equalsIndex !== entry.lastIndexOf("=")) {
      throw new Error(
        `Invalid BITCOIN_PROPAGATION_WITNESSES entry "${rawEntry}". Expected name=rpcUrl.`,
      );
    }

    const name = entry.slice(0, equalsIndex).trim();
    const rpcUrl = entry.slice(equalsIndex + 1).trim();

    if (!name || !rpcUrl) {
      throw new Error(
        `Invalid BITCOIN_PROPAGATION_WITNESSES entry "${rawEntry}". Name and rpcUrl are required.`,
      );
    }

    return {
      name,
      rpcUrl,
    };
  });
}

function parsePiAgentConfig(
  environment: RuntimeEnvironment,
): BouncerRuntimeConfig["piAgent"] {
  const url = environment.PI_AGENT_URL?.trim();

  if (!url) {
    return undefined;
  }

  return {
    url,
    timeoutMs: Number(environment.PI_AGENT_TIMEOUT_MS ?? 1000),
  };
}
