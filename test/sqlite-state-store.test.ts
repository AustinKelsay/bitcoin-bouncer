import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteBouncerStateStore } from "../src/sqlite-state-store.js";

const summary = {
  txid: "abc123",
  vsize: 188,
  weight: 749,
  inputs: 1,
  outputs: 2,
  outputScripts: ["p2tr", "op_return"],
  outputValuesSats: [546, 0],
};

describe("SQLite Bouncer State Store", () => {
  it("returns an Idempotency Record remembered by an earlier store instance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bitcoin-bouncer-state-"));
    const databasePath = join(directory, "bouncer.sqlite");
    const firstStore = createSqliteBouncerStateStore({ databasePath });

    await firstStore.rememberIdempotencyRecord({
      txid: "abc123",
      httpStatus: 200,
      responseBody: {
        status: "submitted",
        txid: "abc123",
        action: "pass",
      },
    });
    firstStore.close();

    const secondStore = createSqliteBouncerStateStore({ databasePath });

    await expect(
      await secondStore.findIdempotencyRecord("abc123"),
    ).toEqual({
      httpStatus: 200,
      responseBody: {
        status: "submitted",
        txid: "abc123",
        action: "pass",
      },
    });
    secondStore.close();
  });

  it("appends audit events and queries them by txid and outcome", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bitcoin-bouncer-state-"));
    const store = createSqliteBouncerStateStore({
      databasePath: join(directory, "bouncer.sqlite"),
    });

    await store.recordAuditEvent({
      txid: "abc123",
      outcome: "pass",
      responseBody: { status: "submitted", txid: "abc123" },
    });
    await store.recordAuditEvent({
      txid: "abc123",
      outcome: "shadow_drop",
      responseBody: { txid: "abc123" },
    });
    await store.recordAuditEvent({
      txid: "def456",
      outcome: "shadow_drop",
      responseBody: { txid: "def456" },
    });

    await expect(
      store.findAuditEvents({ txid: "abc123", outcome: "shadow_drop" }),
    ).resolves.toEqual([
      {
        txid: "abc123",
        outcome: "shadow_drop",
        responseBody: { txid: "abc123" },
      },
    ]);
    store.close();
  });

  it("creates, lists, releases, and discards Hold Queue entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bitcoin-bouncer-state-"));
    const store = createSqliteBouncerStateStore({
      databasePath: join(directory, "bouncer.sqlite"),
    });

    const firstHold = await store.hold({
      rawTx: "020000000001...",
      txid: "abc123",
      reason: "operator review",
      summary,
    });
    const secondHold = await store.hold({
      rawTx: "020000000002...",
      txid: "def456",
      reason: "unusual script path",
      summary: { ...summary, txid: "def456" },
    });

    await store.releaseHold(firstHold.holdId);
    await store.discardHold(secondHold.holdId);

    await expect(store.listHolds()).resolves.toEqual([
      {
        holdId: firstHold.holdId,
        txid: "abc123",
        status: "released",
        reason: "operator review",
        rawTx: "020000000001...",
        summary,
      },
      {
        holdId: secondHold.holdId,
        txid: "def456",
        status: "discarded",
        reason: "unusual script path",
        rawTx: "020000000002...",
        summary: { ...summary, txid: "def456" },
      },
    ]);
    await expect(store.listHolds({ status: "held" })).resolves.toEqual([]);
    store.close();
  });

  it("creates distinct Hold Queue entries for repeated holds of the same txid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bitcoin-bouncer-state-"));
    const store = createSqliteBouncerStateStore({
      databasePath: join(directory, "bouncer.sqlite"),
    });

    const firstHold = await store.hold({
      rawTx: "020000000001...",
      txid: "abc123",
      reason: "operator review",
      summary,
    });
    const secondHold = await store.hold({
      rawTx: "020000000001...",
      txid: "abc123",
      reason: "second operator review",
      summary,
    });

    expect(secondHold.holdId).not.toBe(firstHold.holdId);
    await expect(store.listHolds({ status: "held" })).resolves.toHaveLength(2);
    store.close();
  });

  it("surfaces contextual errors when stored JSON is corrupted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bitcoin-bouncer-state-"));
    const databasePath = join(directory, "bouncer.sqlite");
    const store = createSqliteBouncerStateStore({ databasePath });

    await store.rememberIdempotencyRecord({
      txid: "abc123",
      httpStatus: 200,
      responseBody: { txid: "abc123" },
    });
    store.close();

    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databasePath);
    database
      .prepare(
        `
        UPDATE idempotency_records
        SET response_body_json = ?
        WHERE txid = ?
      `,
      )
      .run("{not-json", "abc123");
    database.close();

    const corruptedStore = createSqliteBouncerStateStore({ databasePath });

    await expect(
      corruptedStore.findIdempotencyRecord("abc123"),
    ).rejects.toThrow(
      "Failed to parse Idempotency Record response body for txid abc123",
    );
    corruptedStore.close();
  });

  it("stores Shadow Realm records and appends Shadow Escape observations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bitcoin-bouncer-state-"));
    const store = createSqliteBouncerStateStore({
      databasePath: join(directory, "bouncer.sqlite"),
    });

    await store.shadowDrop({
      rawTx: "020000000001...",
      txid: "abc123",
      reason: "returned txid; withheld from gate node",
      summary,
    });
    await store.recordShadowEscape({
      txid: "abc123",
      blockHash: "000000000000000000abc",
      blockHeight: 101,
    });

    await expect(store.findShadowDrop("abc123")).resolves.toEqual({
      txid: "abc123",
      reason: "returned txid; withheld from gate node",
      rawTx: "020000000001...",
      summary,
    });
    await expect(store.findShadowEscapes("abc123")).resolves.toEqual([
      {
        txid: "abc123",
        blockHash: "000000000000000000abc",
        blockHeight: 101,
      },
    ]);
    store.close();
  });

  it("resets runtime state for a new Polar network run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bitcoin-bouncer-state-"));
    const store = createSqliteBouncerStateStore({
      databasePath: join(directory, "bouncer.sqlite"),
    });

    await store.rememberIdempotencyRecord({
      txid: "abc123",
      httpStatus: 200,
      responseBody: { txid: "abc123" },
    });
    await store.recordAuditEvent({
      txid: "abc123",
      outcome: "shadow_drop",
      responseBody: { txid: "abc123" },
    });
    await store.hold({
      rawTx: "020000000001...",
      txid: "abc123",
      reason: "operator review",
      summary,
    });
    await store.shadowDrop({
      rawTx: "020000000001...",
      txid: "abc123",
      reason: "returned txid; withheld from gate node",
      summary,
    });
    await store.recordShadowEscape({
      txid: "abc123",
      blockHash: "000000000000000000abc",
      blockHeight: 101,
    });

    await store.reset();

    expect(await store.findIdempotencyRecord("abc123")).toBeUndefined();
    await expect(store.findAuditEvents({ txid: "abc123" })).resolves.toEqual(
      [],
    );
    await expect(store.listHolds()).resolves.toEqual([]);
    await expect(store.findShadowDrop("abc123")).resolves.toBeUndefined();
    await expect(store.findShadowEscapes("abc123")).resolves.toEqual([]);
    store.close();
  });
});
