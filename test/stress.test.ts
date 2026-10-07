import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import {
  computeReport,
  queryByMatrix,
  queryPoint,
  computePrincipal,
  validateStressInput,
  ValidationError,
  normalizeNormalDeg,
} from "../src/core";
import { openDatabase } from "../src/db";
import { createReport, loadReport } from "../src/service";

const EPS = 1e-9;

test("演示工况：主应力 50±sqrt(5000)，主方向 22.5°", () => {
  const p = computePrincipal({ sigmaX: 100, sigmaY: 0, tauXY: 50 });
  assert.ok(Math.abs(p.sigma1 - (50 + Math.sqrt(5000))) < EPS);
  assert.ok(Math.abs(p.sigma2 - (50 - Math.sqrt(5000))) < EPS);
  assert.ok(Math.abs(p.theta1Deg! - 22.5) < EPS);
  assert.ok(Math.abs(p.theta2Deg! - (-67.5)) < EPS || Math.abs(p.theta2Deg! - 112.5) < EPS);
  assert.equal(p.status, "unique");
  assert.ok(Math.abs(p.tauResidual1) < 1e-12);
});

test("演示工况：θ=45° 时 σn=100、τn=-50", () => {
  const q = queryPoint({ sigmaX: 100, sigmaY: 0, tauXY: 50 }, 45);
  assert.ok(Math.abs(q.sigmaN - 100) < EPS);
  assert.ok(Math.abs(q.tauN - -50) < EPS);
  assert.ok(Math.abs(q.sigmaNOrtho - 0) < EPS);
});

test("独立矩阵乘法与二倍角公式一致，且局部向量恢复牵引", () => {
  const input = { sigmaX: 100, sigmaY: 0, tauXY: 50 };
  for (const th of [-370, -90, 0, 22.5, 45, 123.4, 360, 720]) {
    const q = queryPoint(input, th);
    const m = queryByMatrix(input, th);
    assert.ok(Math.abs(q.sigmaN - m.sigmaN) < EPS, `sigmaN @${th}`);
    assert.ok(Math.abs(q.tauN - m.tauN) < EPS, `tauN @${th}`);
    assert.ok(q.residual < 1e-12, `reconstruct @${th}`);
  }
});

test("等双向拉应力：各面剪应力为零，主方向不唯一", () => {
  const input = { sigmaX: 80, sigmaY: 80, tauXY: 0 };
  const p = computePrincipal(input);
  assert.equal(p.isIsotropic, true);
  assert.equal(p.status, "isotropic");
  assert.equal(p.theta1Deg, null);
  assert.deepEqual(p.principalNormals, []);
  assert.equal(p.sigma1, 80);
  assert.equal(p.sigma2, 80);
  for (const th of [0, 30, 45, 89]) {
    const q = queryPoint(input, th);
    assert.ok(Math.abs(q.tauN) < EPS);
    assert.ok(Math.abs(q.sigmaN - 80) < EPS);
  }
});

test("纯剪：主方向为 ±45°，主应力 ±|τ|", () => {
  const p = computePrincipal({ sigmaX: 0, sigmaY: 0, tauXY: 40 });
  assert.ok(Math.abs(p.sigma1 - 40) < EPS);
  assert.ok(Math.abs(p.sigma2 - -40) < EPS);
  assert.ok(
    Math.abs(p.theta1Deg! - 45) < EPS || Math.abs(p.theta1Deg! - -45) < EPS
  );
});

test("纯剪负剪应力：较大主方向为 -45°", () => {
  const p = computePrincipal({ sigmaX: 0, sigmaY: 0, tauXY: -40 });
  assert.ok(Math.abs(p.theta1Deg! - -45) < EPS);
});

test("最大面内切应力两面符号相反，相差 90°，正应力均为 m", () => {
  const r = computeReport({ sigmaX: 100, sigmaY: 0, tauXY: 50 }, []);
  const [f1, f2] = r.maxShear.faces;
  assert.ok(Math.abs(f1.tau + f2.tau) < EPS);
  assert.ok(Math.abs(Math.abs(f1.tau) - r.principal.radius) < EPS);
  let diff = Math.abs(f1.normalDeg - f2.normalDeg);
  diff = Math.min(diff, 180 - diff);
  assert.ok(Math.abs(diff - 90) < 1e-9);
  assert.ok(Math.abs(f1.sigma - r.principal.mean) < EPS);
  assert.ok(Math.abs(f2.sigma - r.principal.mean) < EPS);
});

test("迹与行列式在任意旋转查询下不变（报告原值与主值）", () => {
  const input = { sigmaX: -120, sigmaY: 60, tauXY: -35 };
  const r = computeReport(input, [17, 200]);
  const trace0 = input.sigmaX + input.sigmaY;
  const det0 = input.sigmaX * input.sigmaY - input.tauXY ** 2;
  assert.ok(Math.abs(r.principal.sigma1 + r.principal.sigma2 - trace0) < EPS);
  assert.ok(
    Math.abs(r.principal.sigma1 * r.principal.sigma2 - det0) < 1e-7
  );
  assert.ok(Math.abs(r.invariants.trace - trace0) < EPS);
  assert.ok(Math.abs(r.invariants.determinant - det0) < EPS);
  for (const q of r.queries) {
    assert.ok(Math.abs(q.sigmaN + q.sigmaNOrtho - trace0) < EPS);
  }
});

test("主方向正交（点积为零）", () => {
  const p = computePrincipal({ sigmaX: 30, sigmaY: -10, tauXY: 25 });
  const [n1, n2] = p.principalNormals;
  assert.ok(Math.abs(n1.x * n2.x + n1.y * n2.y) < 1e-12);
});

test("莫尔圆查询点满足圆方程，2θ 关系成立", () => {
  const r = computeReport({ sigmaX: 100, sigmaY: 0, tauXY: 50 }, [0, 45]);
  for (const pt of r.mohr.queriedPoints) {
    assert.ok(Math.abs(pt.onCircleResidual) < 1e-7);
  }
  assert.equal(r.mohr.center.sigma, 50);
  assert.equal(r.mohr.inPlaneOnly, true);
});

test("法向角 180° 周期规范化", () => {
  assert.ok(Math.abs(normalizeNormalDeg(180)) < EPS);
  assert.ok(Math.abs(normalizeNormalDeg(400) - 40) < EPS);
  assert.ok(Math.abs(normalizeNormalDeg(-200) - -20) < EPS);
});

test("零应力状态：各向同性", () => {
  const p = computePrincipal({ sigmaX: 0, sigmaY: 0, tauXY: 0 });
  assert.equal(p.isIsotropic, true);
  assert.equal(p.theta1Deg, null);
});

test("近各向同性（极小 r）返回不唯一而非假零度", () => {
  const p = computePrincipal({ sigmaX: 10, sigmaY: 10, tauXY: 1e-12 });
  assert.equal(p.isIsotropic, true);
  assert.equal(p.theta1Deg, null);
});

test("校验：NaN/Infinity/超限独立报错，不与各向同性混淆", () => {
  assert.throws(
    () => validateStressInput({ sigmaX: NaN, sigmaY: 0, tauXY: 0 }),
    (e: Error) => e instanceof ValidationError && (e as ValidationError).code === "INVALID_NUMBER"
  );
  assert.throws(
    () => validateStressInput({ sigmaX: 1e12, sigmaY: 0, tauXY: 0 }),
    (e: Error) => (e as ValidationError).code === "OUT_OF_RANGE"
  );
});

test("SQLite 持久化、幂等与重启后可读", () => {
  const dir = join(tmpdir(), "stress-test-" + Date.now());
  const dbPath = join(dir, "stress.db");
  const db1 = openDatabase(dbPath);
  const c1 = createReport(db1, {
    sigmaX: 100,
    sigmaY: 0,
    tauXY: 50,
    angles: [45],
    idemKey: "k1",
  });
  assert.equal(c1.inserted, true);
  const c2 = createReport(db1, {
    sigmaX: 100,
    sigmaY: 0,
    tauXY: 50,
    angles: [45],
    idemKey: "k1",
  });
  assert.equal(c2.inserted, false);
  assert.equal(c2.id, c1.id);
  db1.close();

  const db2 = openDatabase(dbPath);
  const loaded = loadReport(db2, c1.id);
  assert.ok(loaded);
  assert.ok(Math.abs(loaded!.queries[0].sigmaN - 100) < EPS);
  db2.close();
  rmSync(dir, { recursive: true, force: true });
});
