export type RunLogActionFilter =
  | "all"
  | "pass"
  | "tag"
  | "hold"
  | "drop"
  | "shadow_drop"
  | "preflight_reject"
  | "queue_full_pass"
  | "hold_queue_full_pass";

export type FilterableRunEvent = {
  detail?: unknown;
};

export function filterRunEvents<TEvent extends FilterableRunEvent>(
  events: TEvent[],
  action: RunLogActionFilter,
): TEvent[] {
  if (action === "all") {
    return events;
  }

  return events.filter((event) => readRunEventOutcome(event.detail) === action);
}

export function readRunEventOutcome(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const detail = value as Record<string, unknown>;
  const action = typeof detail.action === "string" ? detail.action : undefined;
  const status = typeof detail.status === "string" ? detail.status : undefined;
  const handling =
    typeof detail.handling === "string" ? detail.handling : undefined;

  return action ?? status ?? handling;
}
