#!/usr/bin/env node
import { Store } from "./db";
import { startServer } from "./server";
import { parseAngles, queryFaces, fullReport, compareCases, reportToCsv } from "./report";
import { faceAt, principals, maxInPlaneShear, mohrCircle, invariants } from "./core/stress";
import { stateOf } from "./db";

function out(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}

function fail(msg: string): never {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function runDemo(): void {
  const line = (s: string) => console.log(s);
  line("=== 演示 1：σx=100, σy=0, τxy=50 MPa ===");
  const s1 = { sigmaX: 100, sigmaY: 0, tauXY: 50 };
  const p1 = principals(s1);
  line(`主应力: σ1=${p1.sigma1.toFixed(6)} MPa, σ2=${p1.sigma2.toFixed(6)} MPa（期望 50±√5000 ≈ ${50 + Math.sqrt(5000)} / ${50 - Math.sqrt(5000)}）`);
  line(`较大主方向: θp1=${p1.thetaP1Deg} deg（期望 22.5）, 另一方向 θp2=${p1.thetaP2Deg} deg`);
  const f45 = faceAt(s1, 45);
  line(`θ=45°: σn=${f45.sigmaN} MPa（期望 100）, τn=${f45.tauN} MPa（期望 -50）, 回代残差=${f45.reconstructionResidual.toExponential(3)}`);
  const ms1 = maxInPlaneShear(s1);
  line(`最大面内剪应力 |τmax|=${ms1.tauMaxAbs.toFixed(6)} MPa，面: ${JSON.stringify(ms1.faces)}`);
  line("");
  line("=== 演示 2：等双向拉应力 σx=σy=80, τxy=0 MPa ===");
  const s2 = { sigmaX: 80, sigmaY: 80, tauXY: 0 };
  const p2 = principals(s2);
  line(`isotropic=${p2.isotropic}（期望 true），θp1=${p2.thetaP1Deg}（期望 null，方向不唯一）`);
  const checks = [0, 30, 77.7, 135].map((a) => faceAt(s2, a).tauN);
  line(`任意面剪应力: ${checks.map((v) => v.toExponential(3)).join(", ")}（均应为 0）`);
  line("");
  line("=== 演示 3：纯剪应力 σx=σy=0, τxy=40 MPa ===");
  const s3 = { sigmaX: 0, sigmaY: 0, tauXY: 40 };
  const p3 = principals(s3);
  line(`主应力: σ1=${p3.sigma1}, σ2=${p3.sigma2} MPa（期望 ±40）`);
  line(`主方向: θp1=${p3.thetaP1Deg} deg, θp2=${p3.thetaP2Deg} deg（期望 ±45）`);
  line("");
  line("=== 不变量核验（演示 1）===");
  const inv = invariants(s1);
  line(`迹=${inv.trace}（=σ1+σ2=${p1.sigma1 + p1.sigma2}），行列式=${inv.determinant}（=σ1·σ2=${p1.sigma1 * p1.sigma2}）`);
  const mc = mohrCircle(s1, [0, 45, 90]);
  line(`莫尔圆: 圆心=(${mc.center[0]},${mc.center[1]}), 半径=${mc.radius.toFixed(6)}`);
  for (const pt of mc.points) {
    line(`  θ=${pt.thetaDeg}° → (σn=${pt.sigmaN.toFixed(4)}, τn=${pt.tauN.toFixed(4)})，圆方程残差=${pt.onCircleResidual.toExponential(3)}`);
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);

  if (!cmd || cmd === "help" || flags.help) {
    console.log(`平面应力旋转与莫尔圆核验后端（教学用）
用法: node dist/cli.js <命令> [参数]
  serve [--port N]                 启动 HTTP API（默认自动选择空闲端口）
  demo                             运行三组教学演示
  create --sigmaX V --sigmaY V --tauXY V [--name S] [--tolerance V]
  list                             列出全部工况
  show <id>                        查看工况
  report <id> [--angles 0,45,90]   完整报告（不变量/主方向/莫尔圆）
  query <id> --angles 0,45,90      批量查询指定法向角的面应力
  principals <id>                  主应力、主方向与最大面内剪应力
  mohr <id> [--angles 0,15,...]    莫尔圆点表
  compare <idA> <idB>              比较两个工况
  export <id> [--format json|csv] [--angles ...]
单位固定 MPa，拉应力为正。`);
    return;
  }

  if (cmd === "demo") {
    runDemo();
    return;
  }

  const store = new Store();
  try {
    switch (cmd) {
      case "serve": {
        const port = flags.port ? Number(flags.port) : 0;
        if (!Number.isInteger(port) || port < 0 || port > 65535) fail("--port 必须是 0-65535 的整数");
        const { port: actual } = await startServer(store, port);
        console.log(`API 已启动: http://127.0.0.1:${actual}/api/health （Ctrl+C 停止）`);
        return;
      }
      case "create": {
        const { record, existed } = store.createCase({
          sigmaX: flags.sigmaX !== undefined ? Number(flags.sigmaX) : undefined,
          sigmaY: flags.sigmaY !== undefined ? Number(flags.sigmaY) : undefined,
          tauXY: flags.tauXY !== undefined ? Number(flags.tauXY) : undefined,
          name: flags.name,
          tolerance: flags.tolerance !== undefined ? Number(flags.tolerance) : undefined,
        });
        out({ case: record, existed });
        break;
      }
      case "list":
        out({ cases: store.listCases() });
        break;
      case "show":
        out({ case: store.requireCase(positional[0]) });
        break;
      case "report": {
        const rec = store.requireCase(positional[0]);
        const angles = flags.angles ? parseAngles(flags.angles.split(",").map(Number)) : undefined;
        out(fullReport(rec, angles));
        break;
      }
      case "query": {
        const rec = store.requireCase(positional[0]);
        if (!flags.angles) fail("缺少 --angles，例如 --angles 0,45,90");
        out(queryFaces(rec, parseAngles(flags.angles.split(",").map(Number))));
        break;
      }
      case "principals": {
        const rec = store.requireCase(positional[0]);
        const state = stateOf(rec);
        out({
          caseId: rec.id,
          principals: principals(state, rec.tolerance),
          maxInPlaneShear: maxInPlaneShear(state, rec.tolerance),
        });
        break;
      }
      case "mohr": {
        const rec = store.requireCase(positional[0]);
        const angles = flags.angles
          ? parseAngles(flags.angles.split(",").map(Number))
          : Array.from({ length: 13 }, (_, i) => i * 15);
        out({ caseId: rec.id, mohr: mohrCircle(stateOf(rec), angles) });
        break;
      }
      case "compare": {
        const a = store.requireCase(positional[0]);
        const b = store.requireCase(positional[1]);
        out(compareCases(a, b));
        break;
      }
      case "export": {
        const rec = store.requireCase(positional[0]);
        const angles = flags.angles ? parseAngles(flags.angles.split(",").map(Number)) : [0, 30, 45, 60, 90];
        if ((flags.format ?? "json") === "csv") {
          process.stdout.write(reportToCsv(rec, angles));
        } else if (flags.format === "json" || flags.format === undefined) {
          out(fullReport(rec, angles));
        } else {
          fail("--format 仅支持 json 或 csv");
        }
        break;
      }
      default:
        fail(`未知命令: ${cmd}（用 help 查看用法）`);
    }
  } finally {
    if (cmd !== "serve") store.close();
  }
}

main().catch((err) => {
  if (err && err.code) {
    console.error(`错误 [${err.code}]: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
