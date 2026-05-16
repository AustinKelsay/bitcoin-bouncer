export type MempoolVisibilityNode = {
  name: string;
  hasTransactionInMempool(txid: string): Promise<boolean>;
};

export type PropagationExpectation = "present" | "absent";

export type PropagationVerificationResult = {
  txid: string;
  expected: PropagationExpectation;
  passed: boolean;
  nodes: Array<{
    name: string;
    visible: boolean;
    passed: boolean;
  }>;
};

export async function verifyPropagation(input: {
  txid: string;
  expected: PropagationExpectation;
  gateNode: MempoolVisibilityNode;
  propagationWitnesses: MempoolVisibilityNode[];
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<PropagationVerificationResult> {
  const nodes = [input.gateNode, ...input.propagationWitnesses];
  const timeoutMs = input.timeoutMs ?? 5_000;
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let results = await observeNodes({
    nodes,
    txid: input.txid,
    expected: input.expected,
  });

  while (
    input.expected === "present" &&
    !results.every((result) => result.passed) &&
    Date.now() < deadline
  ) {
    await delay(pollIntervalMs);
    results = await observeNodes({
      nodes,
      txid: input.txid,
      expected: input.expected,
    });
  }

  return {
    txid: input.txid,
    expected: input.expected,
    passed: results.every((result) => result.passed),
    nodes: results,
  };
}

async function observeNodes(input: {
  nodes: MempoolVisibilityNode[];
  txid: string;
  expected: PropagationExpectation;
}) {
  return Promise.all(
    input.nodes.map(async (node) => {
      const visible = await node.hasTransactionInMempool(input.txid);

      return {
        name: node.name,
        visible,
        passed: input.expected === "present" ? visible : !visible,
      };
    }),
  );
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
