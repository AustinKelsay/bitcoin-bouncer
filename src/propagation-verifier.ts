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
}): Promise<PropagationVerificationResult> {
  const nodes = [input.gateNode, ...input.propagationWitnesses];
  const results = await Promise.all(
    nodes.map(async (node) => {
      const visible = await node.hasTransactionInMempool(input.txid);

      return {
        name: node.name,
        visible,
        passed: input.expected === "present" ? visible : !visible,
      };
    }),
  );

  return {
    txid: input.txid,
    expected: input.expected,
    passed: results.every((result) => result.passed),
    nodes: results,
  };
}
