import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BouncerStateStore, TxSummary } from "./domain.js";

type StoredIdempotencyRecord = {
  http_status: number;
  response_body_json: string;
};

type StoredAuditEvent = {
  txid: string;
  outcome: string;
  response_body_json: string;
  prompt_hash: string | null;
};

type StoredHold = {
  hold_id: string;
  txid: string;
  status: "held" | "released" | "discarded";
  reason: string;
  raw_tx: string;
  summary_json: string;
};

type StoredShadowDrop = {
  txid: string;
  reason: string;
  raw_tx: string;
  summary_json: string;
};

type StoredShadowEscape = {
  txid: string;
  block_hash: string;
  block_height: number;
};

type StoredRunEvent = {
  id: number;
  run_id: string;
  source: "smoke" | "fuzz" | "propagation";
  name: string;
  status: "running" | "passed" | "failed" | "skipped";
  detail_json: string | null;
  created_at: string;
};

export type SqliteBouncerStateStore = BouncerStateStore & {
  findAuditEvents: NonNullable<BouncerStateStore["findAuditEvents"]>;
  listHolds: NonNullable<BouncerStateStore["listHolds"]>;
  releaseHold: NonNullable<BouncerStateStore["releaseHold"]>;
  discardHold: NonNullable<BouncerStateStore["discardHold"]>;
  findShadowDrop: NonNullable<BouncerStateStore["findShadowDrop"]>;
  recordShadowEscape: NonNullable<BouncerStateStore["recordShadowEscape"]>;
  findShadowEscapes: NonNullable<BouncerStateStore["findShadowEscapes"]>;
  listRunEvents: NonNullable<BouncerStateStore["listRunEvents"]>;
  recordRunEvent: NonNullable<BouncerStateStore["recordRunEvent"]>;
  clearRunEvents: NonNullable<BouncerStateStore["clearRunEvents"]>;
  close(): void;
};

export function createSqliteBouncerStateStore(input: {
  databasePath: string;
}): SqliteBouncerStateStore {
  if (input.databasePath !== ":memory:") {
    mkdirSync(dirname(input.databasePath), { recursive: true });
  }

  const database = new DatabaseSync(input.databasePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_records (
      txid TEXT PRIMARY KEY,
      http_status INTEGER NOT NULL,
      response_body_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      txid TEXT NOT NULL,
      outcome TEXT NOT NULL,
      response_body_json TEXT NOT NULL,
      prompt_hash TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS hold_queue (
      hold_id TEXT PRIMARY KEY,
      txid TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      raw_tx TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS shadow_realm (
      txid TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      raw_tx TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS shadow_escapes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      txid TEXT NOT NULL,
      block_hash TEXT NOT NULL,
      block_height INTEGER NOT NULL,
      observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      source TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      detail_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return {
    async findIdempotencyRecord(txid) {
      const record = database
        .prepare(
          `
          SELECT http_status, response_body_json
          FROM idempotency_records
          WHERE txid = ?
        `,
        )
        .get(txid) as StoredIdempotencyRecord | undefined;

      if (!record) {
        return undefined;
      }

      return {
        httpStatus: record.http_status,
        responseBody: safeJsonParse(
          record.response_body_json,
          `Idempotency Record response body for txid ${txid}`,
        ),
      };
    },
    rememberIdempotencyRecord(record) {
      database
        .prepare(
          `
          INSERT INTO idempotency_records (
            txid,
            http_status,
            response_body_json
          )
          VALUES (?, ?, ?)
          ON CONFLICT(txid) DO UPDATE SET
            http_status = excluded.http_status,
            response_body_json = excluded.response_body_json
        `,
        )
        .run(
          record.txid,
          record.httpStatus,
          JSON.stringify(record.responseBody),
        );
    },
    recordAuditEvent(event) {
      database
        .prepare(
          `
          INSERT INTO audit_events (
            txid,
            outcome,
            response_body_json,
            prompt_hash
          )
          VALUES (?, ?, ?, ?)
        `,
        )
        .run(
          event.txid,
          event.outcome,
          JSON.stringify(event.responseBody),
          event.promptHash ?? null,
        );
    },
    async findAuditEvents(query) {
      let sql = `
        SELECT txid, outcome, response_body_json, prompt_hash
        FROM audit_events
      `;
      const params: string[] = [];
      const conditions: string[] = [];

      if (query.txid) {
        conditions.push("txid = ?");
        params.push(query.txid);
      }

      if (query.outcome) {
        conditions.push("outcome = ?");
        params.push(query.outcome);
      }

      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(" AND ")}`;
      }

      sql += " ORDER BY id ASC";

      const events = database.prepare(sql).all(...params) as StoredAuditEvent[];

      return events.map((event) => ({
        txid: event.txid,
        outcome: event.outcome,
        responseBody: safeJsonParse(
          event.response_body_json,
          `Audit Event response body for txid ${event.txid}`,
        ),
        ...(event.prompt_hash ? { promptHash: event.prompt_hash } : {}),
      }));
    },
    recordTag() {},
    hold(hold) {
      const holdId = `hold_${hold.txid}_${randomUUID()}`;
      database
        .prepare(
          `
          INSERT INTO hold_queue (
            hold_id,
            txid,
            status,
            reason,
            raw_tx,
            summary_json
          )
          VALUES (?, ?, 'held', ?, ?, ?)
        `,
        )
        .run(
          holdId,
          hold.txid,
          hold.reason,
          hold.rawTx,
          JSON.stringify(hold.summary),
        );

      return { holdId };
    },
    async listHolds(query = {}) {
      const params: string[] = [];
      let sql = `
        SELECT hold_id, txid, status, reason, raw_tx, summary_json
        FROM hold_queue
      `;

      if (query.status) {
        sql += " WHERE status = ?";
        params.push(query.status);
      }

      sql += " ORDER BY created_at ASC, hold_id ASC";

      const holds = database.prepare(sql).all(...params) as StoredHold[];

      return holds.map((hold) => ({
        holdId: hold.hold_id,
        txid: hold.txid,
        status: hold.status,
        reason: hold.reason,
        rawTx: hold.raw_tx,
        summary: safeJsonParse<TxSummary>(
          hold.summary_json,
          `Hold Queue summary for hold ${hold.hold_id}`,
        ),
      }));
    },
    async releaseHold(holdId) {
      updateHoldStatus(database, holdId, "released");
    },
    async discardHold(holdId) {
      updateHoldStatus(database, holdId, "discarded");
    },
    shadowDrop(shadowDrop) {
      database
        .prepare(
          `
          INSERT INTO shadow_realm (
            txid,
            reason,
            raw_tx,
            summary_json
          )
          VALUES (?, ?, ?, ?)
          ON CONFLICT(txid) DO NOTHING
        `,
        )
        .run(
          shadowDrop.txid,
          shadowDrop.reason,
          shadowDrop.rawTx,
          JSON.stringify(shadowDrop.summary),
        );
    },
    async findShadowDrop(txid) {
      const shadowDrop = database
        .prepare(
          `
          SELECT txid, reason, raw_tx, summary_json
          FROM shadow_realm
          WHERE txid = ?
        `,
        )
        .get(txid) as StoredShadowDrop | undefined;

      if (!shadowDrop) {
        return undefined;
      }

      return {
        txid: shadowDrop.txid,
        reason: shadowDrop.reason,
        rawTx: shadowDrop.raw_tx,
        summary: safeJsonParse<TxSummary>(
          shadowDrop.summary_json,
          `Shadow Realm summary for txid ${shadowDrop.txid}`,
        ),
      };
    },
    async recordShadowEscape(escape) {
      database
        .prepare(
          `
          INSERT INTO shadow_escapes (
            txid,
            block_hash,
            block_height
          )
          VALUES (?, ?, ?)
        `,
        )
        .run(escape.txid, escape.blockHash, escape.blockHeight);
    },
    async findShadowEscapes(txid) {
      const escapes = database
        .prepare(
          `
          SELECT txid, block_hash, block_height
          FROM shadow_escapes
          WHERE txid = ?
          ORDER BY id ASC
        `,
        )
        .all(txid) as StoredShadowEscape[];

      return escapes.map((escape) => ({
        txid: escape.txid,
        blockHash: escape.block_hash,
        blockHeight: escape.block_height,
      }));
    },
    async listRunEvents() {
      const events = database
        .prepare(
          `
          SELECT id, run_id, source, name, status, detail_json, created_at
          FROM run_events
          ORDER BY id ASC
        `,
        )
        .all() as StoredRunEvent[];

      return events.map(toRunEvent);
    },
    async recordRunEvent(event) {
      const result = database
        .prepare(
          `
          INSERT INTO run_events (
            run_id,
            source,
            name,
            status,
            detail_json
          )
          VALUES (?, ?, ?, ?, ?)
        `,
        )
        .run(
          event.runId,
          event.source,
          event.name,
          event.status,
          event.detail === undefined ? null : JSON.stringify(event.detail),
        );
      const storedEvent = database
        .prepare(
          `
          SELECT id, run_id, source, name, status, detail_json, created_at
          FROM run_events
          WHERE id = ?
        `,
        )
        .get(result.lastInsertRowid) as StoredRunEvent;

      return toRunEvent(storedEvent);
    },
    async clearRunEvents() {
      database.exec("DELETE FROM run_events;");
    },
    reset() {
      database.exec(`
        DELETE FROM idempotency_records;
        DELETE FROM audit_events;
        DELETE FROM hold_queue;
        DELETE FROM shadow_realm;
        DELETE FROM shadow_escapes;
      `);
    },
    close() {
      database.close();
    },
  };
}

function updateHoldStatus(
  database: DatabaseSync,
  holdId: string,
  status: "released" | "discarded",
) {
  database
    .prepare(
      `
      UPDATE hold_queue
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE hold_id = ?
    `,
    )
    .run(status, holdId);
}

function toRunEvent(event: StoredRunEvent) {
  return {
    id: event.id,
    runId: event.run_id,
    source: event.source,
    name: event.name,
    status: event.status,
    ...(event.detail_json
      ? {
          detail: safeJsonParse(
            event.detail_json,
            `Bouncer Run Event detail for event ${event.id}`,
          ),
        }
      : {}),
    createdAt: event.created_at,
  };
}

function safeJsonParse<T = unknown>(json: string, context: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${context}: ${message}`, {
      cause: error,
    });
  }
}
