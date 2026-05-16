import { describe, expect, it, vi } from "vitest";
import {
  createDemoRunEventPublisher,
  createRunId,
} from "../src/demo-run-events.js";

describe("Demo Run Event Publisher", () => {
  it("publishes smoke and fuzz run events to the Bouncer API", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    });
    const publisher = createDemoRunEventPublisher({
      bouncerUrl: "http://127.0.0.1:3130",
      fetch,
    });

    await publisher.publish({
      runId: "smoke-123",
      source: "smoke",
      name: "Bouncer Runtime ready",
      status: "passed",
      detail: { gateNode: "backend1" },
    });

    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:3130/v1/demo/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "smoke-123",
        source: "smoke",
        name: "Bouncer Runtime ready",
        status: "passed",
        detail: { gateNode: "backend1" },
      }),
    });
  });

  it("can publish to a dedicated demo event URL when the script talks to a different runtime", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    });
    const publisher = createDemoRunEventPublisher({
      bouncerUrl: "http://127.0.0.1:3131",
      eventUrl: "http://127.0.0.1:3130/v1/demo/events",
      fetch,
    });

    await publisher.publish({
      runId: "forced_actions-123",
      source: "smoke",
      name: "Forced drop observed",
      status: "passed",
      detail: { action: "drop", txid: "abc123" },
    });

    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:3130/v1/demo/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "forced_actions-123",
        source: "smoke",
        name: "Forced drop observed",
        status: "passed",
        detail: { action: "drop", txid: "abc123" },
      }),
    });
  });

  it("does not fail a smoke test when dashboard event publishing fails", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("connection refused"));
    const warn = vi.fn();
    const publisher = createDemoRunEventPublisher({
      bouncerUrl: "http://127.0.0.1:3130",
      fetch,
      warn,
    });

    await expect(
      publisher.publish({
        runId: "smoke-123",
        source: "smoke",
        name: "Bouncer Runtime ready",
        status: "passed",
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "Failed to publish demo run event: connection refused",
    );
  });

  it("can flush pending best-effort event posts before a script exits", async () => {
    let resolveFetch: () => void = () => {};
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = () =>
            resolve({
              ok: true,
              json: vi.fn().mockResolvedValue({}),
            } as unknown as Response);
        }),
    );
    const publisher = createDemoRunEventPublisher({
      bouncerUrl: "http://127.0.0.1:3130",
      fetch,
    });

    void publisher.publish({
      runId: "smoke-123",
      source: "smoke",
      name: "smoke complete",
      status: "passed",
    });
    const flushed = publisher.flush();
    resolveFetch();

    await expect(flushed).resolves.toBeUndefined();
  });

  it("creates stable run ids with a source prefix", () => {
    expect(createRunId("smoke", new Date("2026-05-16T20:00:00.000Z"))).toBe(
      "smoke-2026-05-16T20-00-00-000Z",
    );
  });
});
