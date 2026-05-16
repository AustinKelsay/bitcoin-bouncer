import type { BouncerStateStore } from "./domain.js";

export type GateNodeBlock = {
  hash: string;
  height: number;
  txids: string[];
};

export type GateNodeBlockSource = {
  getBlockByHeight(height: number): Promise<GateNodeBlock>;
};

export type ShadowEscapeObservation = {
  txid: string;
  blockHash: string;
  blockHeight: number;
};

export async function scanGateNodeBlocksForShadowEscapes(input: {
  blockSource: GateNodeBlockSource;
  stateStore: Pick<BouncerStateStore, "findShadowDrop" | "recordShadowEscape">;
  fromHeight: number;
  toHeight: number;
}): Promise<{
  scannedBlocks: number;
  shadowEscapes: ShadowEscapeObservation[];
}> {
  const shadowEscapes: ShadowEscapeObservation[] = [];

  for (let height = input.fromHeight; height <= input.toHeight; height += 1) {
    const block = await input.blockSource.getBlockByHeight(height);

    for (const txid of block.txids) {
      const shadowDrop = await input.stateStore.findShadowDrop?.(txid);

      if (!shadowDrop) {
        continue;
      }

      const observation = {
        txid,
        blockHash: block.hash,
        blockHeight: block.height,
      };

      await input.stateStore.recordShadowEscape?.(observation);
      shadowEscapes.push(observation);
    }
  }

  return {
    scannedBlocks: Math.max(0, input.toHeight - input.fromHeight + 1),
    shadowEscapes,
  };
}
