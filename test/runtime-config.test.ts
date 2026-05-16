import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadBouncerRuntimeConfig,
  saveBouncerPromptFile,
} from "../src/runtime-config.js";

describe("Bouncer Runtime Config", () => {
  it("loads the configured Bouncer Prompt at startup and computes its sha256 hash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bitcoin-bouncer-"));
    const promptPath = join(directory, "bouncer.prompt.md");
    await writeFile(promptPath, "Prefer pass unless the shape is meaningfully bad.\n");

    await expect(
      loadBouncerRuntimeConfig({
        BOUNCER_PROMPT_PATH: promptPath,
        BITCOIN_GATE_NODE_NAME: "backend1",
        BITCOIN_RPC_URL: "http://127.0.0.1:18443",
        BITCOIN_RPC_USER: "polaruser",
        BITCOIN_RPC_PASSWORD: "polarpass",
        BITCOIN_PROPAGATION_WITNESSES: "backend2=http://127.0.0.1:18444,backend3=http://127.0.0.1:18445",
        BOUNCER_MODEL_BASE_URL: "http://127.0.0.1:11434",
        BOUNCER_MODEL_API_KEY: "test-key",
        BOUNCER_MODEL_NAME: "tool-model",
        BOUNCER_MODEL_TIMEOUT_MS: "750",
        BOUNCER_DECISION_MAX_PENDING: "4",
      }),
    ).resolves.toEqual({
      prompt: {
        path: promptPath,
        content: "Prefer pass unless the shape is meaningfully bad.\n",
        hash: "sha256:e4853892a4e82af08fcc2dd7c3e61ec8c5b1aadf7dd501415819a76c3ebfb5cf",
      },
      state: {
        databasePath: "state/bouncer.sqlite",
      },
      gateNode: {
        name: "backend1",
        rpc: {
          url: "http://127.0.0.1:18443",
          username: "polaruser",
          password: "polarpass",
        },
      },
      propagationWitnesses: [
        { name: "backend2", rpcUrl: "http://127.0.0.1:18444" },
        { name: "backend3", rpcUrl: "http://127.0.0.1:18445" },
      ],
      decisionQueue: {
        maxPending: 4,
      },
      model: {
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:11434",
        apiKey: "test-key",
        name: "tool-model",
        timeoutMs: 750,
      },
    });
  });

  it("requires explicit Gate Node RPC credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bitcoin-bouncer-"));
    const promptPath = join(directory, "bouncer.prompt.md");
    await writeFile(promptPath, "Prefer pass.\n");

    await expect(
      loadBouncerRuntimeConfig({
        BOUNCER_PROMPT_PATH: promptPath,
        BITCOIN_GATE_NODE_NAME: "backend1",
        BITCOIN_RPC_URL: "http://127.0.0.1:18443",
        BITCOIN_RPC_USER: "polaruser",
      }),
    ).rejects.toThrow(
      "Missing required runtime environment variable: BITCOIN_RPC_PASSWORD",
    );
  });

  it("surfaces the prompt path when startup cannot read the Bouncer Prompt", async () => {
    await expect(
      loadBouncerRuntimeConfig({
        BOUNCER_PROMPT_PATH: "/tmp/missing-bouncer.prompt.md",
        BITCOIN_GATE_NODE_NAME: "backend1",
        BITCOIN_RPC_URL: "http://127.0.0.1:18443",
        BITCOIN_RPC_USER: "polaruser",
        BITCOIN_RPC_PASSWORD: "polarpass",
      }),
    ).rejects.toThrow(
      "Failed to read Bouncer Prompt at /tmp/missing-bouncer.prompt.md",
    );
  });

  it("saves an edited Bouncer Prompt file and reports the new hash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bitcoin-bouncer-"));
    const promptPath = join(directory, "bouncer.prompt.md");
    await writeFile(promptPath, "Prefer pass.\n");

    await expect(
      saveBouncerPromptFile(
        promptPath,
        "Prefer hold when the candidate looks weird.\n",
      ),
    ).resolves.toEqual({
      prompt: "Prefer hold when the candidate looks weird.\n",
      promptHash:
        "sha256:c14e36e0137bb173a998835191ccbc0b3cbee3fc17bb7755db26fa92ac798d5c",
    });
    await expect(readFile(promptPath, "utf8")).resolves.toBe(
      "Prefer hold when the candidate looks weird.\n",
    );
  });

  it("rejects malformed Propagation Witness entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bitcoin-bouncer-"));
    const promptPath = join(directory, "bouncer.prompt.md");
    await writeFile(promptPath, "Prefer pass.\n");

    await expect(
      loadBouncerRuntimeConfig({
        BOUNCER_PROMPT_PATH: promptPath,
        BITCOIN_GATE_NODE_NAME: "backend1",
        BITCOIN_RPC_URL: "http://127.0.0.1:18443",
        BITCOIN_RPC_USER: "polaruser",
        BITCOIN_RPC_PASSWORD: "polarpass",
        BITCOIN_PROPAGATION_WITNESSES: "backend2",
      }),
    ).rejects.toThrow(
      'Invalid BITCOIN_PROPAGATION_WITNESSES entry "backend2". Expected name=rpcUrl.',
    );
  });

  it("can force a deterministic Live Agent action for plumbing smoke runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bitcoin-bouncer-"));
    const promptPath = join(directory, "bouncer.prompt.md");
    await writeFile(promptPath, "Prefer pass.\n");

    await expect(
      loadBouncerRuntimeConfig({
        BOUNCER_PROMPT_PATH: promptPath,
        BITCOIN_GATE_NODE_NAME: "backend1",
        BITCOIN_RPC_URL: "http://127.0.0.1:18443",
        BITCOIN_RPC_USER: "polaruser",
        BITCOIN_RPC_PASSWORD: "polarpass",
        BOUNCER_FORCE_ACTION: "hold",
      }),
    ).resolves.toMatchObject({
      forcedAction: {
        action: "hold",
        reason: "forced smoke hold",
      },
    });
  });
});
