import type { PiAgentClient } from "./pi-live-agent-adapter.js";

type FetchLike = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export function createPiHttpAgentClient(input: {
  url: string;
  fetch?: FetchLike;
}): PiAgentClient {
  const fetcher = input.fetch ?? fetch;

  return {
    async decide(request) {
      const response = await fetcher(input.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        throw new Error(`Pi Agent HTTP ${response.status}`);
      }

      const action = extractAgentAction(await response.json());

      if (!isRecord(action) || typeof action.action !== "string") {
        throw new Error(
          "Pi Agent response did not contain a structured Agent Action",
        );
      }

      return action;
    },
  };
}

function extractAgentAction(responseBody: unknown): unknown {
  if (!isRecord(responseBody)) {
    return responseBody;
  }

  if (typeof responseBody.action === "string") {
    return responseBody;
  }

  for (const key of ["action", "decision", "agentAction", "result"]) {
    const value = responseBody[key];

    if (isRecord(value) && typeof value.action === "string") {
      return value;
    }
  }

  const outputAction = extractOpenAiStyleOutputJson(responseBody);

  return outputAction;
}

function extractOpenAiStyleOutputJson(
  responseBody: Record<string, unknown>,
): unknown {
  if (!Array.isArray(responseBody.output)) {
    return undefined;
  }

  for (const outputItem of responseBody.output) {
    if (!isRecord(outputItem) || !Array.isArray(outputItem.content)) {
      continue;
    }

    for (const contentItem of outputItem.content) {
      if (!isRecord(contentItem)) {
        continue;
      }

      const json = contentItem.json;

      if (
        contentItem.type === "output_json" &&
        isRecord(json) &&
        typeof json.action === "string"
      ) {
        return json;
      }
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
