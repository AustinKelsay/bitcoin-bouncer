import { describe, expect, it, vi } from "vitest";
import { verifyPropagation } from "../src/propagation-verifier.js";

describe("Propagation verifier", () => {
  it("confirms a passed transaction is visible on the Gate Node and all Propagation Witnesses", async () => {
    const result = await verifyPropagation({
      txid: "abc123",
      expected: "present",
      gateNode: {
        name: "backend1",
        hasTransactionInMempool: vi.fn().mockResolvedValue(true),
      },
      propagationWitnesses: [
        {
          name: "backend2",
          hasTransactionInMempool: vi.fn().mockResolvedValue(true),
        },
        {
          name: "backend3",
          hasTransactionInMempool: vi.fn().mockResolvedValue(true),
        },
      ],
    });

    expect(result).toEqual({
      txid: "abc123",
      expected: "present",
      passed: true,
      nodes: [
        { name: "backend1", visible: true, passed: true },
        { name: "backend2", visible: true, passed: true },
        { name: "backend3", visible: true, passed: true },
      ],
    });
  });

  it("confirms a withheld transaction is absent without recording Shadow Escape", async () => {
    const shadowEscapeRecorder = vi.fn();

    const result = await verifyPropagation({
      txid: "abc123",
      expected: "absent",
      gateNode: {
        name: "backend1",
        hasTransactionInMempool: vi.fn().mockResolvedValue(false),
      },
      propagationWitnesses: [
        {
          name: "backend2",
          hasTransactionInMempool: vi.fn().mockResolvedValue(false),
        },
      ],
      onShadowEscape: shadowEscapeRecorder,
    });

    expect(result.passed).toBe(true);
    expect(shadowEscapeRecorder).not.toHaveBeenCalled();
  });
});
