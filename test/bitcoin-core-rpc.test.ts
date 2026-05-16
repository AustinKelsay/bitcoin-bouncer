import { describe, expect, it, vi } from "vitest";
import { createBitcoinCoreRpc } from "../src/bitcoin-core-rpc.js";

describe("Bitcoin Core RPC client", () => {
  it("surfaces Bitcoin Core JSON-RPC errors even when Core responds with HTTP 500", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValue({
        result: null,
        error: {
          code: -4,
          message: "Insufficient funds",
        },
      }),
    } as unknown as Response);
    const rpc = createBitcoinCoreRpc({
      url: "http://127.0.0.1:18443",
      username: "polaruser",
      password: "polarpass",
    });

    await expect(rpc("walletcreatefundedpsbt", [])).rejects.toThrow(
      "Insufficient funds",
    );
    fetch.mockRestore();
  });
});
