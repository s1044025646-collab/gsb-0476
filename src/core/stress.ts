/**
 * 平面应力核心计算（教学用）。
 *
 * 约定：
 * - 单位固定 MPa，拉应力为正。
 * - 应力张量 S = [[σx, τxy], [τxy, σy]]（对称二阶张量）。
 * - 法向角 θ 自全局 x 轴逆时针，单位为度；n = (cosθ, sinθ)，t = (-sinθ, cosθ)。
 * - 面牵引向量 trac = S·n；σn = n·trac；τn = t·trac。
 * - 二倍角公式：σn = m + d·cos2θ + τxy·sin2θ；τn = -d·sin2θ + τxy·cos2θ，
 *   其中 m = (σx+σy)/2，d = (σx-σy)/2。
 * - 莫尔圆坐标：横轴 σn，纵轴 τn（本题切应力约定），物理法向转 θ 对应圆上 2θ。
 * - 所有角度对外以度表示，内部计算时显式转弧度。
 */
export const UNIT = "MPa";
export const SIGN_CONVENTION = "tension-positive";

export const MAX_STRESS_MPA = 1e9;
export const MAX_ANGLE_DEG = 1e9;
export const MAX_BATCH_ANGLES = 1000;
export const DEFAULT_TOLERANCE = 1e-9;

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function assertFinite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiError("INVALID_INPUT", `${name} 必须是有限数值，收到: ${String(value)}`);
  }
  return value;
}

export function validateStress(v: unknown, name: string): number {
  const x = assertFinite(v, name);
  if (Math.abs(x) > MAX_STRESS_MPA) {
    throw new ApiError("LIMIT_EXCEEDED", `${name} 超出允许范围 ±${MAX_STRESS_MPA} MPa`);
  }
  return x;
}

export function validateAngle(v: unknown, name = "thetaDeg"): number {
  const x = assertFinite(v, name);
  if (Math.abs(x) > MAX_ANGLE_DEG) {
    throw new ApiError("LIMIT_EXCEEDED", `${name} 超出允许范围 ±${MAX_ANGLE_DEG} 度`);
  }
  return x;
}

/** 规范化到 [0, 180) 度（面法向以 180° 为周期）。 */
export function normalize180(deg: number): number {
  let r = deg % 180;
  if (r < 0) r += 180;
  if (180 - r < 1e-12) r = 0;
  return r;
}

/** 规范化到 [-90, 90) 度（主方向表示）。 */
export function normalizePm90(deg: number): number {
  let r = ((((deg + 90) % 180) + 180) % 180) - 90;
  if (r >= 90 - 1e-12) r -= 180;
  return r;
}

export interface StressState {
  sigmaX: number;
  sigmaY: number;
  tauXY: number;
}

export interface FaceResult {
  thetaDegInput: number;
  thetaDegNormalized: number;
  normal: [number, number];
  tangent: [number, number];
  traction: [number, number];
  sigmaN: number;
  tauN: number;
  sigmaNOrthogonal: number;
  localVector: [number, number];
  reconstructedTraction: [number, number];
  reconstructionResidual: number;
}

export function faceAt(state: StressState, thetaDeg: number): FaceResult {
  const { sigmaX, sigmaY, tauXY } = state;
  const rad = (thetaDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const n: [number, number] = [c, s];
  const t: [number, number] = [-s, c];

  const tx = sigmaX * c + tauXY * s;
  const ty = tauXY * c + sigmaY * s;

  const m = (sigmaX + sigmaY) / 2;
  const d = (sigmaX - sigmaY) / 2;
  const cos2 = Math.cos(2 * rad);
  const sin2 = Math.sin(2 * rad);
  const sigmaN = m + d * cos2 + tauXY * sin2;
  const tauN = -d * sin2 + tauXY * cos2;
  const sigmaNOrt = m - d * cos2 - tauXY * sin2;

  const rx = n[0] * sigmaN + t[0] * tauN;
  const ry = n[1] * sigmaN + t[1] * tauN;
  const residual = Math.hypot(rx - tx, ry - ty);

  if (![sigmaN, tauN, sigmaNOrt, residual].every(Number.isFinite)) {
    throw new ApiError("NUMERIC_FAILURE", "面应力计算出现非有限结果", 500);
  }

  return {
    thetaDegInput: thetaDeg,
    thetaDegNormalized: normalize180(thetaDeg),
    normal: n,
    tangent: t,
    traction: [tx, ty],
    sigmaN,
    tauN,
    sigmaNOrthogonal: sigmaNOrt,
    localVector: [sigmaN, tauN],
    reconstructedTraction: [rx, ry],
    reconstructionResidual: residual,
  };
}

export interface PrincipalResult {
  mean: number;
  radius: number;
  sigma1: number;
  sigma2: number;
  isotropic: boolean;
  thetaP1Deg: number | null;
  thetaP2Deg: number | null;
  shearResidualAtP1: number | null;
  shearResidualAtP2: number | null;
  note: string;
}

export function principals(state: StressState, tol = DEFAULT_TOLERANCE): PrincipalResult {
  const { sigmaX, sigmaY, tauXY } = state;
  const m = (sigmaX + sigmaY) / 2;
  const d = (sigmaX - sigmaY) / 2;
  const r = Math.hypot(d, tauXY);
  const sigma1 = m + r;
  const sigma2 = m - r;
  const scale = Math.max(Math.abs(sigmaX), Math.abs(sigmaY), Math.abs(tauXY), 1);
  const isotropic = r <= tol * scale;

  if (isotropic) {
    return {
      mean: m,
      radius: r,
      sigma1,
      sigma2,
      isotropic: true,
      thetaP1Deg: null,
      thetaP2Deg: null,
      shearResidualAtP1: null,
      shearResidualAtP2: null,
      note: "各向同性（面内）应力状态：两主应力相等，主方向不唯一，任意法向剪应力均为零。",
    };
  }

  const thetaP1 = normalizePm90(((Math.atan2(2 * tauXY, sigmaX - sigmaY) * 180) / Math.PI) / 2);
  const thetaP2 = normalizePm90(thetaP1 + 90);
  const f1 = faceAt(state, thetaP1);
  const f2 = faceAt(state, thetaP2);

  return {
    mean: m,
    radius: r,
    sigma1,
    sigma2,
    isotropic: false,
    thetaP1Deg: thetaP1,
    thetaP2Deg: thetaP2,
    shearResidualAtP1: f1.tauN,
    shearResidualAtP2: f2.tauN,
    note: "面内主应力 m±r；主方向为法向角，二者正交；残差为主方向代回后的真实 τn。",
  };
}

export interface MaxShearResult {
  tauMaxAbs: number;
  faces: Array<{ thetaDeg: number; tauSigned: number; sigmaN: number }>;
  note: string;
}

export function maxInPlaneShear(state: StressState, tol = DEFAULT_TOLERANCE): MaxShearResult {
  const p = principals(state, tol);
  if (p.isotropic) {
    return {
      tauMaxAbs: p.radius,
      faces: [],
      note: "各向同性状态：任意面剪应力均为零，无唯一最大剪应力面。",
    };
  }
  const t1 = normalize180((p.thetaP1Deg as number) + 45);
  const t2 = normalize180((p.thetaP1Deg as number) - 45);
  const f1 = faceAt(state, t1);
  const f2 = faceAt(state, t2);
  return {
    tauMaxAbs: p.radius,
    faces: [
      { thetaDeg: t1, tauSigned: f1.tauN, sigmaN: f1.sigmaN },
      { thetaDeg: t2, tauSigned: f2.tauN, sigmaN: f2.sigmaN },
    ],
    note: "最大面内剪应力绝对值 = r，两个面与主方向相差 45°，剪应力符号相反。不包含三维（零面外应力）意义下的最大剪应力。",
  };
}

export interface MohrPoint {
  thetaDeg: number;
  sigmaN: number;
  tauN: number;
  circleAngleDeg: number;
  onCircleResidual: number;
}

export interface MohrCircle {
  center: [number, number];
  radius: number;
  points: MohrPoint[];
  convention: string;
}

export function mohrCircle(state: StressState, anglesDeg: number[]): MohrCircle {
  const m = (state.sigmaX + state.sigmaY) / 2;
  const d = (state.sigmaX - state.sigmaY) / 2;
  const r = Math.hypot(d, state.tauXY);
  const points: MohrPoint[] = anglesDeg.map((deg) => {
    const f = faceAt(state, deg);
    const residual = (f.sigmaN - m) ** 2 + f.tauN ** 2 - r ** 2;
    return {
      thetaDeg: normalize180(deg),
      sigmaN: f.sigmaN,
      tauN: f.tauN,
      circleAngleDeg: 2 * normalize180(deg),
      onCircleResidual: residual,
    };
  });
  return {
    center: [m, 0],
    radius: r,
    points,
    convention:
      "横轴 σn、纵轴 τn（本题切应力约定 t=(-sinθ,cosθ)）。物理法向转动 θ 对应圆上二倍角 2θ。仅为面内莫尔圆，不代表含零面外应力的三维最大剪应力。",
  };
}

export function invariants(state: StressState): { trace: number; determinant: number } {
  return {
    trace: state.sigmaX + state.sigmaY,
    determinant: state.sigmaX * state.sigmaY - state.tauXY * state.tauXY,
  };
}
