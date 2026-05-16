export type BitcoinCoreRpcOptions = {
  url: string;
  username: string;
  password: string;
};

export function createBitcoinCoreRpc(options: BitcoinCoreRpcOptions) {
  return async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const response = await fetch(options.url, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(
          `${options.username}:${options.password}`,
        ).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "1.0",
        id: "bitcoin-bouncer",
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`Bitcoin Core RPC HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      result?: unknown;
      error?: { message?: string } | null;
    };

    if (payload.error) {
      throw new Error(payload.error.message ?? "Bitcoin Core RPC error");
    }

    return payload.result;
  };
}
