import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface CaseRow {
  id: string;
  input_json: string;
  report_json: string;
  thetas_json: string;
  unit: string;
  sign_convention: string;
  angle_unit: string;
  tolerance: number;
  idem_key: string | null;
  created_at: string;
}

export function openDatabase(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      input_json TEXT NOT NULL,
      report_json TEXT NOT NULL,
      thetas_json TEXT NOT NULL,
      unit TEXT NOT NULL,
      sign_convention TEXT NOT NULL,
      angle_unit TEXT NOT NULL,
      tolerance REAL NOT NULL,
      idem_key TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cases_idem
      ON cases(idem_key) WHERE idem_key IS NOT NULL;
  `);
  return db;
}

export interface FrozenMeta {
  unit: string;
  signConvention: string;
  angleUnit: string;
  tolerance: number;
}

export const FROZEN_META: FrozenMeta = {
  unit: "MPa",
  signConvention: "tension positive; S=[[sx,txy],[txy,sy]]; t=(-sin,cos)",
  angleUnit: "degree",
  tolerance: 1e-7,
};

export function insertCase(
  db: DatabaseSync,
  row: {
    id: string;
    inputJson: string;
    reportJson: string;
    thetasJson: string;
    idemKey: string | null;
  }
): { inserted: boolean; id: string } {
  const existing =
    row.idemKey !== null
      ? (db
          .prepare("SELECT id FROM cases WHERE idem_key = ?")
          .get(row.idemKey) as { id: string } | undefined)
      : undefined;
  if (existing) {
    return { inserted: false, id: existing.id };
  }
  db.prepare(
    `INSERT INTO cases
       (id, input_json, report_json, thetas_json, unit, sign_convention, angle_unit, tolerance, idem_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.inputJson,
    row.reportJson,
    row.thetasJson,
    FROZEN_META.unit,
    FROZEN_META.signConvention,
    FROZEN_META.angleUnit,
    FROZEN_META.tolerance,
    row.idemKey,
    new Date().toISOString()
  );
  return { inserted: true, id: row.id };
}

export function getCase(db: DatabaseSync, id: string): CaseRow | undefined {
  return db.prepare("SELECT * FROM cases WHERE id = ?").get(id) as
    | CaseRow
    | undefined;
}

export function listCases(db: DatabaseSync): Array<{
  id: string;
  input_json: string;
  created_at: string;
}> {
  return db
    .prepare("SELECT id, input_json, created_at FROM cases ORDER BY created_at")
    .all() as Array<{ id: string; input_json: string; created_at: string }>;
}
