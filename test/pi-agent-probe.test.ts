import { describe, expect, it, vi } from "vitest";
import {
  createPiAgentProbeRequest,
  probePiAgent,
} from "../src/pi-agent-probe.js";

describe("Pi Agent probe", () => {
  it("sends a representative Bouncer decision request through the Pi Agent client", async () => {
    const client = {
      decide: vi.fn().mockResolvedValue({ action: "pass" }),
    };

    await expect(probePiAgent({ client })).resolves.toEqual({
      action: "pass",
    });
    expect(client.decide).toHaveBeenCalledWith(createPiAgentProbeRequest());
  });
});
