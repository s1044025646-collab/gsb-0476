import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../db";
import { startServer } from "../server";
import { Server } from "node:http";

let store: Store;
let server: Server;
let base: string;
let tmpDir: string;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stress-test-"));
  store = new Store(path.join(tmpDir, "test.db"));
  const started = await startServer(store, 0);
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});

after(() => {
  server.close();
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function post(urlPath: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + urlPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test("创建工况幂等：相同输入返回同一 id", async () => {
  const input = { sigmaX: 100, sigmaY: 0, tauXY: 50, name: "demo" };
  const r1 = await post("/api/cases", input);
  const r2 = await post("/api/cases", input);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 200);
  assert.equal(r2.json.existed, true);
  assert.equal(r1.json.case.id, r2.json.case.id);
  // 修改输入产生新工况
  const r3 = await post("/api/cases", { ...input, tauXY: 51 });
  assert.equal(r3.status, 201);
  assert.notEqual(r3.json.case.id, r1.json.case.id);
});

test("校验与错误码", async () => {
  const bad1 = await post("/api/cases", { sigmaX: NaN, sigmaY: 0, tauXY: 0 });
  assert.equal(bad1.status, 400);
  assert.equal(bad1.json.error.code, "INVALID_INPUT");
  const bad2 = await post("/api/cases", { sigmaX: 1e12, sigmaY: 0, tauXY: 0 });
  assert.equal(bad2.json.error.code, "LIMIT_EXCEEDED");
  const res = await fetch(`${base}/api/cases/nonexistent`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, "NOT_FOUND");
});

test("批量查询、主方向、莫尔圆、导出、比较", async () => {
  const created = await post("/api/cases", { sigmaX: 100, sigmaY: 0, tauXY: 50 });
  const id = created.json.case.id;

  const q = await post(`/api/cases/${id}/query`, { angles: [0, 45, 90] });
  assert.equal(q.status, 200);
  assert.equal(q.json.faces.length, 3);
  assert.ok(Math.abs(q.json.faces[1].sigmaN - 100) < 1e-9);
  assert.ok(Math.abs(q.json.faces[1].tauN + 50) < 1e-9);

  const tooMany = await post(`/api/cases/${id}/query`, { angles: new Array(1001).fill(0) });
  assert.equal(tooMany.json.error.code, "LIMIT_EXCEEDED");

  const p = await fetch(`${base}/api/cases/${id}/principals`);
  const pj = await p.json();
  assert.ok(Math.abs(pj.principals.thetaP1Deg - 22.5) < 1e-9);

  const m = await fetch(`${base}/api/cases/${id}/mohr?angles=0,45,90`);
  const mj = await m.json();
  assert.equal(mj.mohr.points.length, 3);
  assert.ok(Math.abs(mj.mohr.radius - Math.hypot(50, 50)) < 1e-9);

  const e = await fetch(`${base}/api/cases/${id}/export?format=csv`);
  const text = await e.text();
  assert.ok(text.includes("sigmaN_MPa"));

  const c2 = await post("/api/cases", { sigmaX: 60, sigmaY: 20, tauXY: 10 });
  const cmp = await post("/api/compare", { ids: [id, c2.json.case.id] });
  assert.equal(cmp.status, 200);
  assert.ok("sigma1" in cmp.json.delta);
});

test("重启后旧工况仍可查询（持久化）", async () => {
  const created = await post("/api/cases", { sigmaX: 10, sigmaY: 20, tauXY: 5 });
  const id = created.json.case.id;
  store.close();
  store = new Store(path.join(tmpDir, "test.db"));
  const rec = store.requireCase(id);
  assert.equal(rec.sigmaX, 10);
  assert.equal(rec.unit, "MPa");
});
