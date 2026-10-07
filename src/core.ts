// 平面应力核心计算：全部公式自行实现，不依赖任何数值库。
// 约定（冻结于每份报告）：
//   单位 MPa，拉应力为正
//   张量 S = [[sx, txy],[txy, sy]]
//   法向 n=(cosθ,sinθ)，θ 从全局 x 轴逆时针，单位为度
//   切向 t=(-sinθ,cosθ)
//   牵引 traction = S·n；σn=n·traction；τn=t·traction

export const ABS_LIMIT = 1e9; // 应力/角度绝对数量上限（MPa / 度）
export const ISO_R_TOL = 1e-7; // r 小于该值（相对/绝对混合判定）视为各向同性

export interface StressInput {
  sigmaX: number;
  sigmaY: number;
  tauXY: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface QueryPoint {
  thetaDeg: number; // 输入角（度，原样）
  normalDeg: number; // 规范化到 [-90,90) 的法向角
  normal: Vec2;
  tangent: Vec2;
  traction: Vec2; // S·n
  sigmaN: number; // 面正应力
  tauN: number; // 面切应力（本题切向约定下有符号）
  sigmaNOrtho: number; // 正交法向 θ+90° 上的正应力
  tractionFromLocal: Vec2; // n·σn + t·τn，应与 traction 一致
  residual: number; // traction 与 tractionFromLocal 之差的最大分量绝对值
}

export interface PrincipalResult {
  sigma1: number; // 较大主应力 m+r
  sigma2: number; // 较小主应力 m-r
  mean: number;
  radius: number;
  isIsotropic: boolean; // r≈0，方向不唯一
  status: "unique" | "isotropic";
  theta1Deg: number | null; // 较大主应力法向角，规范化 [-90,90)；各向同性为 null
  theta2Deg: number | null; // 与 theta1 正交
  principalNormals: Vec2[]; // 各向同性时为空数组
  tauResidual1: number; // 主方向代回后的真实剪应力残差（不强制写零）
  tauResidual2: number;
}

export interface MaxShearFace {
  normalDeg: number;
  tau: number; // 有符号最大面内切应力
  sigma: number; // 该面上的正应力（等于 m）
}

export interface MaxShearResult {
  absMax: number; // = r（面内）
  faces: MaxShearFace[]; // 两个法向相差 90°，剪应力符号相反；各向同性为空
  note: string;
}

export interface MohrCircle {
  center: { sigma: number; tau: number };
  radius: number;
  xAxis: "sigmaN (MPa, tension positive)";
  yAxis: "tauN (per problem tangent convention)";
  angleRelation: "physical normal rotation theta -> plotted angle 2theta; tau axis sign follows t=(-sin,cos)";
  queriedPoints: Array<{
    normalDeg: number;
    twoThetaDeg: number;
    sigma: number;
    tau: number;
    onCircleResidual: number; // (sigma-m)^2 + tau^2 - r^2
  }>;
  inPlaneOnly: true;
}

export interface StressReport {
  input: StressInput;
  invariants: { trace: number; determinant: number };
  principal: PrincipalResult;
  maxShear: MaxShearResult;
  queries: QueryPoint[];
  mohr: MohrCircle;
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function validateStressInput(input: Partial<StressInput>): StressInput {
  const { sigmaX, sigmaY, tauXY } = input as StressInput;
  for (const [name, v] of [
    ["sigmaX", sigmaX],
    ["sigmaY", sigmaY],
    ["tauXY", tauXY],
  ] as const) {
    if (!isFiniteNumber(v)) {
      throw new ValidationError(`${name} 必须为有限数值（不得为 NaN/Infinity）`, "INVALID_NUMBER");
    }
    if (Math.abs(v) > ABS_LIMIT) {
      throw new ValidationError(`${name} 超出数量上限 ${ABS_LIMIT} MPa`, "OUT_OF_RANGE");
    }
  }
  return { sigmaX, sigmaY, tauXY };
}

export class ValidationError extends Error {
  code: string;
  constructor(message: string, code = "VALIDATION_ERROR") {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

function deg2rad(d: number): number {
  return (d * Math.PI) / 180;
}

// 规范化到 [-90,90)：法向具有 180° 周期
export function normalizeNormalDeg(thetaDeg: number): number {
  const span = 180;
  return ((thetaDeg + 90) % span + span) % span - 90;
}

function matVec(S: number[][], n: Vec2): Vec2 {
  return {
    x: S[0][0] * n.x + S[0][1] * n.y,
    y: S[1][0] * n.x + S[1][1] * n.y,
  };
}

function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

function maxAbsComponentDiff(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

// 独立矩阵乘法核对：直接由张量与方向向量计算，不经过二倍角公式
export function queryByMatrix(input: StressInput, thetaDeg: number): {
  traction: Vec2;
  sigmaN: number;
  tauN: number;
  n: Vec2;
  t: Vec2;
} {
  const r = deg2rad(thetaDeg);
  const n = { x: Math.cos(r), y: Math.sin(r) };
  const t = { x: -Math.sin(r), y: Math.cos(r) };
  const S = [
    [input.sigmaX, input.tauXY],
    [input.tauXY, input.sigmaY],
  ];
  const traction = matVec(S, n);
  return { traction, sigmaN: dot(n, traction), tauN: dot(t, traction), n, t };
}

export function queryPoint(input: StressInput, thetaDeg: number): QueryPoint {
  if (!isFiniteNumber(thetaDeg)) {
    throw new ValidationError("角度必须为有限数值（度）", "INVALID_NUMBER");
  }
  if (Math.abs(thetaDeg) > ABS_LIMIT) {
    throw new ValidationError(`角度超出数量上限 ${ABS_LIMIT} 度`, "OUT_OF_RANGE");
  }
  const { sigmaX, sigmaY, tauXY } = input;
  const m = (sigmaX + sigmaY) / 2;
  const d = (sigmaX - sigmaY) / 2;
  const two = deg2rad(2 * thetaDeg);
  const c = Math.cos(two);
  const s = Math.sin(two);

  const sigmaN = m + d * c + tauXY * s;
  const tauN = -d * s + tauXY * c;
  const sigmaNOrtho = m - d * c - tauXY * s;

  const matrix = queryByMatrix(input, thetaDeg);
  const tractionFromLocal = {
    x: matrix.n.x * sigmaN + matrix.t.x * tauN,
    y: matrix.n.y * sigmaN + matrix.t.y * tauN,
  };
  const residual = maxAbsComponentDiff(matrix.traction, tractionFromLocal);

  return {
    thetaDeg,
    normalDeg: normalizeNormalDeg(thetaDeg),
    normal: matrix.n,
    tangent: matrix.t,
    traction: matrix.traction,
    sigmaN,
    tauN,
    sigmaNOrtho,
    tractionFromLocal,
    residual,
  };
}

export function computePrincipal(input: StressInput): PrincipalResult {
  const { sigmaX, sigmaY, tauXY } = input;
  const m = (sigmaX + sigmaY) / 2;
  const d = (sigmaX - sigmaY) / 2;
  const r = Math.hypot(d, tauXY);
  const sigma1 = m + r;
  const sigma2 = m - r;

  const scale = Math.max(1, Math.abs(m));
  const isIsotropic = r <= ISO_R_TOL * scale;

  if (isIsotropic) {
    return {
      sigma1: m,
      sigma2: m,
      mean: m,
      radius: r,
      isIsotropic: true,
      status: "isotropic",
      theta1Deg: null,
      theta2Deg: null,
      principalNormals: [],
      tauResidual1: r,
      tauResidual2: r,
    };
  }

  let theta1 = (Math.atan2(2 * tauXY, sigmaX - sigmaY) * 180) / Math.PI / 2;
  theta1 = normalizeNormalDeg(theta1);
  const theta2 = normalizeNormalDeg(theta1 + 90);

  const n1 = {
    x: Math.cos(deg2rad(theta1)),
    y: Math.sin(deg2rad(theta1)),
  };
  const n2 = {
    x: Math.cos(deg2rad(theta2)),
    y: Math.sin(deg2rad(theta2)),
  };
  const q1 = queryPoint(input, theta1);
  const q2 = queryPoint(input, theta2);

  return {
    sigma1,
    sigma2,
    mean: m,
    radius: r,
    isIsotropic: false,
    status: "unique",
    theta1Deg: theta1,
    theta2Deg: theta2,
    principalNormals: [n1, n2],
    tauResidual1: q1.tauN,
    tauResidual2: q2.tauN,
  };
}

export function computeMaxShear(input: StressInput): MaxShearResult {
  const p = computePrincipal(input);
  if (p.isIsotropic || p.theta1Deg === null || p.theta2Deg === null) {
    return {
      absMax: p.radius,
      faces: [],
      note: "各向同性：所有面剪应力为零，最大剪应力面方向不唯一",
    };
  }
  const a = normalizeNormalDeg(p.theta1Deg + 45);
  const b = normalizeNormalDeg(p.theta1Deg + 135);
  const qa = queryPoint(input, a);
  const qb = queryPoint(input, b);
  return {
    absMax: p.radius,
    faces: [
      { normalDeg: a, tau: qa.tauN, sigma: qa.sigmaN },
      { normalDeg: b, tau: qb.tauN, sigma: qb.sigmaN },
    ],
    note: "面内最大剪应力绝对值为 r；两面法向相差 90°，有符号剪应力相反。仅为面内结果，不含面外零主应力。",
  };
}

export function computeMohr(input: StressInput, queries: QueryPoint[]): MohrCircle {
  const p = computePrincipal(input);
  return {
    center: { sigma: p.mean, tau: 0 },
    radius: p.radius,
    xAxis: "sigmaN (MPa, tension positive)",
    yAxis: "tauN (per problem tangent convention)",
    angleRelation:
      "physical normal rotation theta -> plotted angle 2theta; tau axis sign follows t=(-sin,cos)",
    queriedPoints: queries.map((q) => {
      const twoTheta = ((2 * q.normalDeg) % 360 + 360) % 360;
      return {
        normalDeg: q.normalDeg,
        twoThetaDeg: twoTheta,
        sigma: q.sigmaN,
        tau: q.tauN,
        onCircleResidual:
          (q.sigmaN - p.mean) ** 2 + q.tauN ** 2 - p.radius ** 2,
      };
    }),
    inPlaneOnly: true,
  };
}

export function computeReport(
  input: StressInput,
  thetaDegs: number[]
): StressReport {
  const safe = validateStressInput(input);
  const queries = thetaDegs.map((th) => queryPoint(safe, th));
  const principal = computePrincipal(safe);
  return {
    input: safe,
    invariants: {
      trace: safe.sigmaX + safe.sigmaY,
      determinant:
        safe.sigmaX * safe.sigmaY - safe.tauXY * safe.tauXY,
    },
    principal,
    maxShear: computeMaxShear(safe),
    queries,
    mohr: computeMohr(safe, queries),
  };
}
