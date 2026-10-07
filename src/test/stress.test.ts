import { test } from "node:test";
import assert from "node:assert/strict";
import {
  faceAt,
  principals,
  maxInPlaneShear,
  mohrCircle,
  invariants,
  normalize180,
  StressState,
} from "../core/stress";

/** 独立矩阵乘法核对：S' = Q^T S Q，Q 的列为 (n, t)。 */
function matrixRotate(s: StressState, thetaDeg: number): { sn: number; tn: number } {
  const rad = (thetaDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const si = Math.sin(rad);
  // n=(c,si), t=(-si,c)
  const sn = c * (s.sigmaX * c + s.tauXY * si) + si * (s.tauXY * c + s.sigmaY * si);
  const tn = -si * (s.sigmaX * c + s.tauXY * si) + c * (s.tauXY * c + s.sigmaY * si);
  return { sn, tn };
}

const CASES: StressState[] = [
  { sigmaX: 100, sigmaY: 0, tauXY: 50 }, // 演示 1
  { sigmaX: 0, sigmaY: 0, tauXY: 0 }, // 零应力
  { sigmaX: -120, sigmaY: -40, tauXY: 0 }, // 压应力
  { sigmaX: 50, sigmaY: 80, tauXY: -30 }, // 负剪应力
  { sigmaX: 80, sigmaY: 80, tauXY: 0 }, // 各向同性
  { sigmaX: 0, sigmaY: 0, tauXY: 40 }, // 纯剪
  { sigmaX: 100.0000001, sigmaY: 100, tauXY: 0 }, // 近各向同性
];

const ANGLES = [0, 22.5, 45, 90, 135, 180, 225, -45, -180, 360, 725.5, -1000];

test("二倍角公式与独立矩阵乘法一致，且回代恢复牵引", () => {
  for (const s of CASES) {
    for (const a of ANGLES) {
      const f = faceAt(s, a);
      const ref = matrixRotate(s, a);
      assert.ok(Math.abs(f.sigmaN - ref.sn) < 1e-8, `sigmaN mismatch at ${a}`);
      assert.ok(Math.abs(f.tauN - ref.tn) < 1e-8, `tauN mismatch at ${a}`);
      assert.ok(f.reconstructionResidual < 1e-10, "traction reconstruction");
      // 正交面对应正应力之和 = 迹
      assert.ok(Math.abs(f.sigmaN + f.sigmaNOrthogonal - (s.sigmaX + s.sigmaY)) < 1e-8);
    }
  }
});

test("演示 1：σx=100, σy=0, τxy=50", () => {
  const s = { sigmaX: 100, sigmaY: 0, tauXY: 50 };
  const p = principals(s);
  assert.ok(Math.abs(p.sigma1 - (50 + Math.sqrt(5000))) < 1e-9);
  assert.ok(Math.abs(p.sigma2 - (50 - Math.sqrt(5000))) < 1e-9);
  assert.ok(Math.abs((p.thetaP1Deg as number) - 22.5) < 1e-9);
  assert.ok(Math.abs((p.thetaP2Deg as number) - (22.5 - 90)) < 1e-9);
  assert.ok(Math.abs(p.shearResidualAtP1 as number) < 1e-10);
  const f = faceAt(s, 45);
  assert.ok(Math.abs(f.sigmaN - 100) < 1e-9);
  assert.ok(Math.abs(f.tauN + 50) < 1e-9);
});

test("等双向拉应力：各向同性、方向不唯一、任意面剪应力为零", () => {
  const p = principals({ sigmaX: 80, sigmaY: 80, tauXY: 0 });
  assert.equal(p.isotropic, true);
  assert.equal(p.thetaP1Deg, null);
  assert.equal(p.thetaP2Deg, null);
  for (const a of ANGLES) {
    assert.ok(Math.abs(faceAt({ sigmaX: 80, sigmaY: 80, tauXY: 0 }, a).tauN) < 1e-10);
  }
});

test("纯剪应力：主方向 ±45°，主应力 ±τ", () => {
  const p = principals({ sigmaX: 0, sigmaY: 0, tauXY: 40 });
  assert.equal(p.isotropic, false);
  assert.ok(Math.abs(p.sigma1 - 40) < 1e-12);
  assert.ok(Math.abs(p.sigma2 + 40) < 1e-12);
  assert.ok(Math.abs((p.thetaP1Deg as number) - 45) < 1e-12);
  assert.ok(Math.abs((p.thetaP2Deg as number) + 45) < 1e-12);
});

test("主方向正交且代回剪应力残差小", () => {
  for (const s of CASES) {
    const p = principals(s);
    if (p.isotropic) continue;
    const diff = Math.abs(normalize180((p.thetaP1Deg as number) - (p.thetaP2Deg as number)) - 90);
    assert.ok(diff < 1e-9, "principal directions orthogonal");
    assert.ok(Math.abs(p.shearResidualAtP1 as number) < 1e-8);
    assert.ok(Math.abs(p.shearResidualAtP2 as number) < 1e-8);
  }
});

test("迹与行列式在旋转下不变", () => {
  for (const s of CASES) {
    const inv = invariants(s);
    const p = principals(s);
    assert.ok(Math.abs(inv.trace - (p.sigma1 + p.sigma2)) < 1e-8);
    assert.ok(Math.abs(inv.determinant - p.sigma1 * p.sigma2) < 1e-6);
    for (const a of ANGLES) {
      const f = faceAt(s, a);
      const detRot = f.sigmaN * f.sigmaNOrthogonal - f.tauN ** 2;
      assert.ok(Math.abs(detRot - inv.determinant) < 1e-6, `det invariant at ${a}`);
    }
  }
});

test("最大面内剪应力：|τmax|=r，两面相差 90° 且符号相反", () => {
  const s = { sigmaX: 100, sigmaY: 0, tauXY: 50 };
  const ms = maxInPlaneShear(s);
  assert.ok(Math.abs(ms.tauMaxAbs - Math.hypot(50, 50)) < 1e-9);
  assert.equal(ms.faces.length, 2);
  const [f1, f2] = ms.faces;
  assert.ok(Math.abs(f1.tauSigned + f2.tauSigned) < 1e-9);
  assert.ok(Math.abs(Math.abs(f1.tauSigned) - ms.tauMaxAbs) < 1e-9);
  assert.ok(Math.abs(normalize180(f1.thetaDeg - f2.thetaDeg) - 90) < 1e-9);
  assert.ok(Math.abs(f1.sigmaN - 50) < 1e-9);
});

test("莫尔圆：圆上点满足圆方程，2θ 关系", () => {
  for (const s of CASES) {
    const mc = mohrCircle(s, ANGLES);
    const m = (s.sigmaX + s.sigmaY) / 2;
    assert.ok(Math.abs(mc.center[0] - m) < 1e-12);
    for (const pt of mc.points) {
      const scale = Math.max(mc.radius ** 2, 1);
      assert.ok(Math.abs(pt.onCircleResidual) < 1e-6 * scale, "on-circle residual");
      assert.ok(Math.abs(pt.circleAngleDeg - 2 * pt.thetaDeg) < 1e-9);
    }
  }
});

test("角度跨周期：θ 与 θ+180 同面，规范化到 [0,180)", () => {
  const s = { sigmaX: 30, sigmaY: -10, tauXY: 15 };
  const a = faceAt(s, 37);
  const b = faceAt(s, 217);
  const c = faceAt(s, -143);
  assert.ok(Math.abs(a.sigmaN - b.sigmaN) < 1e-9);
  assert.ok(Math.abs(a.tauN - b.tauN) < 1e-9);
  assert.ok(Math.abs(a.sigmaN - c.sigmaN) < 1e-9);
  assert.equal(a.thetaDegNormalized, 37);
  assert.equal(b.thetaDegNormalized, 37);
  assert.equal(c.thetaDegNormalized, 37);
});

test("近各向同性：不误判，方向仍有效", () => {
  const p = principals({ sigmaX: 100.001, sigmaY: 100, tauXY: 0 });
  assert.equal(p.isotropic, false);
  assert.ok(p.thetaP1Deg !== null);
  // 偏差在容差内时按各向同性处理，且不给假方向
  const q = principals({ sigmaX: 100 + 1e-10, sigmaY: 100, tauXY: 0 });
  assert.equal(q.isotropic, true);
  assert.equal(q.thetaP1Deg, null);
});
