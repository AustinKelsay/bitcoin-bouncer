import { describe, expect, it } from "vitest";
import { filterRunEvents } from "../demo/src/run-log-filters.js";

describe("Run Log Filters", () => {
  it("shows only run events matching the selected Live Agent action", () => {
    const events = [
      runEvent({ id: 1, name: "Passed candidate", action: "pass" }),
      runEvent({ id: 2, name: "Dropped candidate", action: "drop" }),
      runEvent({ id: 3, name: "Shadow dropped candidate", action: "shadow_drop" }),
      runEvent({ id: 4, name: "Rejected by preflight", action: undefined, status: "preflight_reject" }),
      runEvent({ id: 5, name: "Propagation check", action: undefined }),
    ];

    expect(filterRunEvents(events, "drop").map((event) => event.id)).toEqual([2]);
    expect(filterRunEvents(events, "shadow_drop").map((event) => event.id)).toEqual([3]);
    expect(filterRunEvents(events, "pass").map((event) => event.id)).toEqual([1]);
    expect(filterRunEvents(events, "preflight_reject").map((event) => event.id)).toEqual([4]);
    expect(filterRunEvents(events, "all").map((event) => event.id)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });
});

function runEvent(input: {
  id: number;
  name: string;
  action?: string;
  status?: string;
}) {
  return {
    id: input.id,
    runId: "run-1",
    source: "smoke" as const,
    name: input.name,
    status: "passed" as const,
    detail: input.action || input.status
      ? {
          action: input.action,
          status: input.status,
          txid: `tx-${input.id}`,
          handling: input.action ?? input.status,
        }
      : undefined,
    createdAt: "2026-05-16T12:00:00.000Z",
  };
}
