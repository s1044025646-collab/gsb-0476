import {
  StressState,
  faceAt,
  principals,
  maxInPlaneShear,
  mohrCircle,
  invariants,
  validateAngle,
  MAX_BATCH_ANGLES,
  ApiError,
  UNIT,
  SIGN_CONVENTION,
} from "./core/stress";
import { CaseRecord, stateOf } from "./db";

export function parseAngles(input: unknown): number[] {
  if (!Array.isArray(input)) {
    throw new ApiError("INVALID_INPUT", "angles 必须是角度（度）数组");
  }
  if (input.length === 0) {
    throw new ApiError("INVALID_INPUT", "angles 不能为空");
  }
  if (input.length > MAX_BATCH_ANGLES) {
    throw new ApiError("LIMIT_EXCEEDED", `单次查询角度数量上限为 ${MAX_BATCH_ANGLES}`);
  }
  return input.map((v, i) => validateAngle(v, `angles[${i}]`));
}

export function queryFaces(rec: CaseRecord, angles: number[]) {
  const state = stateOf(rec);
  return {
    caseId: rec.id,
    unit: rec.unit,
    signConvention: rec.signConvention,
    faces: angles.map((a) => faceAt(state, a)),
  };
}

export function fullReport(rec: CaseRecord, angles: number[] = [0, 30, 45, 60, 90]) {
  const state = stateOf(rec);
  return {
    case: rec,
    unit: UNIT,
    signConvention: SIGN_CONVENTION,
    invariants: invariants(state),
    principals: principals(state, rec.tolerance),
    maxInPlaneShear: maxInPlaneShear(state, rec.tolerance),
    mohr: mohrCircle(state, angles),
    scope:
      "仅二维平面应力教学计算；不含梁挠度、有限元、材料屈服、结构安全判定或三维强度分析。",
  };
}

export function compareCases(a: CaseRecord, b: CaseRecord) {
  const sa = stateOf(a);
  const sb = stateOf(b);
  const pa = principals(sa, a.tolerance);
  const pb = principals(sb, b.tolerance);
  return {
    caseA: a.id,
    caseB: b.id,
    delta: {
      sigmaX: sb.sigmaX - sa.sigmaX,
      sigmaY: sb.sigmaY - sa.sigmaY,
      tauXY: sb.tauXY - sa.tauXY,
      sigma1: pb.sigma1 - pa.sigma1,
      sigma2: pb.sigma2 - pa.sigma2,
      radius: pb.radius - pa.radius,
      mean: pb.mean - pa.mean,
    },
    principalsA: pa,
    principalsB: pb,
    unit: UNIT,
  };
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function reportToCsv(rec: CaseRecord, angles: number[]): string {
  const state = stateOf(rec);
  const p = principals(state, rec.tolerance);
  const ms = maxInPlaneShear(state, rec.tolerance);
  const lines: string[] = [];
  lines.push("section,key,value,unit");
  lines.push(`case,id,${csvEscape(rec.id)},`);
  lines.push(`case,sigmaX,${rec.sigmaX},${UNIT}`);
  lines.push(`case,sigmaY,${rec.sigmaY},${UNIT}`);
  lines.push(`case,tauXY,${rec.tauXY},${UNIT}`);
  lines.push(`case,signConvention,${rec.signConvention},`);
  lines.push(`principals,sigma1,${p.sigma1},${UNIT}`);
  lines.push(`principals,sigma2,${p.sigma2},${UNIT}`);
  lines.push(`principals,isotropic,${p.isotropic},`);
  lines.push(`principals,thetaP1Deg,${p.thetaP1Deg ?? ""},deg`);
  lines.push(`principals,thetaP2Deg,${p.thetaP2Deg ?? ""},deg`);
  lines.push(`maxInPlaneShear,tauMaxAbs,${ms.tauMaxAbs},${UNIT}`);
  lines.push("");
  lines.push("thetaDeg,sigmaN_MPa,tauN_MPa,sigmaNOrthogonal_MPa,tractionX_MPa,tractionY_MPa,reconstructionResidual");
  for (const a of angles) {
    const f = faceAt(state, a);
    lines.push(
      `${f.thetaDegNormalized},${f.sigmaN},${f.tauN},${f.sigmaNOrthogonal},${f.traction[0]},${f.traction[1]},${f.reconstructionResidual}`,
    );
  }
  return lines.join("\r\n") + "\r\n";
}
