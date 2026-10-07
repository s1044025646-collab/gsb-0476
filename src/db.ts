import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  StressState,
  UNIT,
  SIGN_CONVENTION,
  DEFAULT_TOLERANCE,
  validateStress,
  validateAngle,
  ApiError,
} from "./core/stress";

export const DATA_DIR = path.join(process.cwd(), "data");
export const DB_PATH = path.join(DATA_DIR, "stress.db");

export interface CaseRecord {
  id: string;
  name: string | null;
  sigmaX: number;
  sigmaY: number;
  tauXY: number;
  unit: string;
  signConvention: string;
  angleConvention: string;
  tolerance: number;
  inputHash: string;
  createdAt: string;
}

const ANGLE_CONVENTION =
  "theta deg CCW from global x; n=(cos,sin); t=(-sin,cos); face normal period 180deg";

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string = DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cases (
        id TEXT PRIMARY KEY,
        name TEXT,
        sigma_x REAL NOT NULL,
        sigma_y REAL NOT NULL,
        tau_xy REAL NOT NULL,
        unit TEXT NOT NULL,
        sign_convention TEXT NOT NULL,
        angle_convention TEXT NOT NULL,
        tolerance REAL NOT NULL,
        input_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private hashInput(s: StressState, tolerance: number): string {
    const payload = [s.sigmaX, s.sigmaY, s.tauXY, UNIT, SIGN_CONVENTION, ANGLE_CONVENTION, tolerance].join("|");
    return crypto.createHash("sha256").update(payload).digest("hex");
  }

  /** 幂等创建：相同输入（含约定与容差）返回已有工况，不产生新报告。 */
  createCase(input: {
    sigmaX: unknown;
    sigmaY: unknown;
    tauXY: unknown;
    name?: unknown;
    tolerance?: unknown;
  }): { record: CaseRecord; existed: boolean } {
    const state: StressState = {
      sigmaX: validateStress(input.sigmaX, "sigmaX"),
      sigmaY: validateStress(input.sigmaY, "sigmaY"),
      tauXY: validateStress(input.tauXY, "tauXY"),
    };
    let tolerance = DEFAULT_TOLERANCE;
    if (input.tolerance !== undefined && input.tolerance !== null) {
      tolerance = validateAngle(input.tolerance, "tolerance");
      if (tolerance <= 0 || tolerance > 1e-3) {
        throw new ApiError("INVALID_INPUT", "tolerance 必须在 (0, 1e-3] 内");
      }
    }
    let name: string | null = null;
    if (input.name !== undefined && input.name !== null) {
      if (typeof input.name !== "string" || input.name.length > 200) {
        throw new ApiError("INVALID_INPUT", "name 必须为不超过 200 字符的字符串");
      }
      name = input.name;
    }
    const hash = this.hashInput(state, tolerance);
    const existing = this.getByHash(hash);
    if (existing) return { record: existing, existed: true };

    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO cases (id, name, sigma_x, sigma_y, tau_xy, unit, sign_convention, angle_convention, tolerance, input_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, name, state.sigmaX, state.sigmaY, state.tauXY, UNIT, SIGN_CONVENTION, ANGLE_CONVENTION, tolerance, hash, new Date().toISOString());
    return { record: this.getCase(id)!, existed: false };
  }

  private getByHash(hash: string): CaseRecord | null {
    const row = this.db.prepare("SELECT * FROM cases WHERE input_hash = ?").get(hash) as any;
    return row ? this.toRecord(row) : null;
  }

  getCase(id: string): CaseRecord | null {
    const row = this.db.prepare("SELECT * FROM cases WHERE id = ?").get(id) as any;
    return row ? this.toRecord(row) : null;
  }

  requireCase(id: string): CaseRecord {
    const rec = this.getCase(id);
    if (!rec) throw new ApiError("NOT_FOUND", `工况不存在: ${id}`, 404);
    return rec;
  }

  listCases(): CaseRecord[] {
    const rows = this.db.prepare("SELECT * FROM cases ORDER BY created_at ASC").all() as any[];
    return rows.map((r) => this.toRecord(r));
  }

  private toRecord(row: any): CaseRecord {
    return {
      id: row.id,
      name: row.name,
      sigmaX: row.sigma_x,
      sigmaY: row.sigma_y,
      tauXY: row.tau_xy,
      unit: row.unit,
      signConvention: row.sign_convention,
      angleConvention: row.angle_convention,
      tolerance: row.tolerance,
      inputHash: row.input_hash,
      createdAt: row.created_at,
    };
  }
}

export function stateOf(rec: CaseRecord): StressState {
  return { sigmaX: rec.sigmaX, sigmaY: rec.sigmaY, tauXY: rec.tauXY };
}
