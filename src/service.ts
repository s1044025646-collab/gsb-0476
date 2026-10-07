import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  computeReport,
  StressInput,
  StressReport,
  ValidationError,
  validateStressInput,
} from "./core";
import { insertCase } from "./db";

export const MAX_QUERY_ANGLES = 1000;

export interface CreateRequest {
  sigmaX: number;
  sigmaY: number;
  tauXY: number;
  angles?: number[];
  idemKey?: string | null;
}

export function validateAngles(angles: unknown): number[] {
  if (angles === undefined || angles === null) return [];
  if (!Array.isArray(angles)) {
    throw new ValidationError("angles 必须为数组", "INVALID_ANGLES");
  }
  if (angles.length > MAX_QUERY_ANGLES) {
    throw new ValidationError(
      `批量查询角度数量超过上限 ${MAX_QUERY_ANGLES}`,
    "TOO_MANY_ANGLES"
    );
  }
  return angles.map((a, i) => {
    if (typeof a !== "number" || !Number.isFinite(a)) {
      throw new ValidationError(
        `angles[${i}] 必须为有限数值（度）`,
        "INVALID_NUMBER"
      );
    }
    if (Math.abs(a) > 1e9) {
      throw new ValidationError(
        `angles[${i}] 超出数量上限 1e9 度`,
        "OUT_OF_RANGE"
      );
    }
    return a;
  });
}

export function parseCreateRequest(body: unknown): CreateRequest {
  if (typeof body !== "object" || body === null) {
    throw new ValidationError("请求体必须为 JSON 对象", "INVALID_BODY");
  }
  const b = body as Record<string, unknown>;
  const input = validateStressInput({
    sigmaX: b.sigmaX as number,
    sigmaY: b.sigmaY as number,
    tauXY: b.tauXY as number,
  });
  const angles = validateAngles(b.angles);
  const idemKey =
    typeof b.idemKey === "string" && b.idemKey.length > 0
      ? b.idemKey.slice(0, 200)
      : null;
  return { ...input, angles, idemKey };
}

// 确定性 ID：相同输入与角度（不考虑 idemKey）内容寻址
export function contentId(req: {
  sigmaX: number;
  sigmaY: number;
  tauXY: number;
  angles: number[];
}): string {
  const payload = JSON.stringify({
    sx: req.sigmaX,
    sy: req.sigmaY,
    txy: req.tauXY,
    a: req.angles,
  });
  return "c_" + createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export interface CreatedReport {
  id: string;
  inserted: boolean;
  report: StressReport;
}

export function createReport(
  db: DatabaseSync,
  raw: unknown
): CreatedReport {
  const req = parseCreateRequest(raw);
  const angles = req.angles ?? [];
  const report = computeReport(
    { sigmaX: req.sigmaX, sigmaY: req.sigmaY, tauXY: req.tauXY },
    angles
  );
  const id = contentId({ ...req, angles });
  const result = insertCase(db, {
    id,
    inputJson: JSON.stringify(report.input),
    reportJson: JSON.stringify(report),
    thetasJson: JSON.stringify(angles),
    // 提供 idemKey 时用 key，否则用内容 id（天然幂等：相同输入返回同一报告）
    idemKey: req.idemKey ?? id,
  });
  return { id: result.id, inserted: result.inserted, report };
}

export function loadReport(
  db: DatabaseSync,
  id: string
): StressReport | undefined {
  const row = db.prepare("SELECT report_json FROM cases WHERE id = ?").get(id) as
    | { report_json: string }
    | undefined;
  return row ? (JSON.parse(row.report_json) as StressReport) : undefined;
}

export function compareReports(a: StressReport, b: StressReport) {
  return {
    a: { id: undefined as string | undefined, input: a.input },
    b: { id: undefined as string | undefined, input: b.input },
    deltaSigma1: b.principal.sigma1 - a.principal.sigma1,
    deltaSigma2: b.principal.sigma2 - a.principal.sigma2,
    deltaRadius: b.principal.radius - a.principal.radius,
    deltaMean: b.principal.mean - a.principal.mean,
  };
}

export function generateId(): string {
  return randomUUID();
}

export function toCsv(report: StressReport): string {
  const lines: string[] = [];
  lines.push("section,field,value");
  lines.push(`input,sigmaX,${report.input.sigmaX}`);
  lines.push(`input,sigmaY,${report.input.sigmaY}`);
  lines.push(`input,tauXY,${report.input.tauXY}`);
  lines.push(`principal,sigma1,${report.principal.sigma1}`);
  lines.push(`principal,sigma2,${report.principal.sigma2}`);
  lines.push(`principal,radius,${report.principal.radius}`);
  lines.push(`principal,status,${report.principal.status}`);
  lines.push(
    `principal,theta1Deg,${
      report.principal.theta1Deg === null
        ? ""
        : report.principal.theta1Deg
    }`
  );
  for (const q of report.queries) {
    lines.push(`query,${q.thetaDeg},sigmaN=${q.sigmaN};tauN=${q.tauN}`);
  }
  return lines.join("\r\n");
}
