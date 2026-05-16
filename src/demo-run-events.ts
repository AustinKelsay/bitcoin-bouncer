export type DemoRunEvent = {
  runId: string;
  source: "smoke" | "fuzz" | "propagation";
  name: string;
  status: "running" | "passed" | "failed" | "skipped";
  detail?: unknown;
};

type Fetch = typeof fetch;

export function createDemoRunEventPublisher(input: {
  bouncerUrl: string;
  eventUrl?: string;
  fetch?: Fetch;
  warn?: (message: string) => void;
}) {
  const fetchFn = input.fetch ?? fetch;
  const warn = input.warn ?? ((message) => console.warn(message));
  const endpoint =
    input.eventUrl ?? `${trimTrailingSlash(input.bouncerUrl)}/v1/demo/events`;
  const pending = new Set<Promise<void>>();

  return {
    publish(event: DemoRunEvent) {
      const publication = publishEvent(event).finally(() => {
        pending.delete(publication);
      });
      pending.add(publication);

      return publication;
    },
    async flush() {
      await Promise.allSettled(Array.from(pending));
    },
  };

  async function publishEvent(event: DemoRunEvent) {
    try {
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });

      if (!response.ok) {
        warn(`Failed to publish demo run event: HTTP ${response.status}`);
      }
    } catch (error) {
      warn(`Failed to publish demo run event: ${errorMessage(error)}`);
    }
  }
}

export function createRunId(source: DemoRunEvent["source"], date = new Date()) {
  return `${source}-${date.toISOString().replaceAll(":", "-").replace(".", "-")}`;
}

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
