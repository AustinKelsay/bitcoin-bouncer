import type {
  PiModelClient,
  PiToolDefinition,
  PiToolCall,
} from "./pi-live-agent-adapter.js";

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

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      tool_calls?: Array<{
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
};

export function createOpenAiCompatibleModelClient(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: FetchLike;
}): PiModelClient {
  const fetcher = input.fetch ?? fetch;

  return {
    async complete(request) {
      const response = await fetcher(
        `${trimTrailingSlash(input.baseUrl)}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${input.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: input.model,
            messages: [
              {
                role: "system",
                content: request.prompt,
              },
              {
                role: "user",
                content: JSON.stringify({
                  promptHash: request.promptHash,
                  transaction: request.transaction,
                  deepTransactionView: request.deepTransactionView,
                }),
              },
            ],
            tools: request.tools.map(toChatCompletionTool),
            tool_choice: "required",
          }),
        },
      );

      const body = (await response.json()) as ChatCompletionResponse;

      if (!response.ok) {
        throw new Error(
          `Model provider HTTP ${response.status}: ${JSON.stringify(body)}`,
        );
      }

      return {
        toolCall: parseFirstToolCall(body),
      };
    },
  };
}

function toChatCompletionTool(tool: PiToolDefinition) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function parseFirstToolCall(
  response: ChatCompletionResponse,
): PiToolCall | undefined {
  const toolCall = response.choices?.[0]?.message?.tool_calls?.[0]?.function;

  if (!toolCall?.name) {
    return undefined;
  }

  return {
    name: toolCall.name,
    arguments: toolCall.arguments ? JSON.parse(toolCall.arguments) : {},
  };
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
