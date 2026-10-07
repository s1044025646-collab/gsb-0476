#!/usr/bin/env node
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { openDatabase } from "./db";
import { ValidationError } from "./core";
import {
  createReport,
  loadReport,
  toCsv,
  CreateRequest,
} from "./service";

const DATA_DIR = process.env.STRESS_DATA_DIR ?? join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "stress.db");

function usage(): void {
  console.log(`平面应力教学 CLI（单位 MPa，拉为正，角度为度）

用法:
  stress save --sx 100 --sy 0 --txy 50 [--angles 0,45,90] [--idem KEY]
  stress get <id>
  stress list
  stress principal <id>
  stress mohr <id>
  stress compare <idA> <idB>
  stress export <id> [--format json|csv] [--out file]
  stress demo

环境变量:
  STRESS_DATA_DIR  数据目录（默认 ./data）
`);
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function printJson(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}

function demo(db: ReturnType<typeof openDatabase>): void {
  const cases: Array<{ label: string; req: CreateRequest }> = [
    {
      label: "示例 1：sx=100 sy=0 txy=50，查询 0/45/90 度",
      req: {
        sigmaX: 100,
        sigmaY: 0,
        tauXY: 50,
        angles: [0, 45, 90],
      },
    },
    {
      label: "示例 2：等双向拉应力 sx=sy=80（各向同性，主方向不唯一）",
      req: { sigmaX: 80, sigmaY: 80, tauXY: 0, angles: [0, 30, 45] },
    },
    {
      label: "示例 3：纯剪 txy=40（主方向为 ±45 度）",
      req: { sigmaX: 0, sigmaY: 0, tauXY: 40, angles: [45, -45] },
    },
  ];
  for (const c of cases) {
    console.log("\n=== " + c.label + " ===");
    const created = createReport(db, c.req);
    const r = created.report;
    console.log(`id=${created.id}  trace=${r.invariants.trace}  det=${r.invariants.determinant}`);
    console.log(
      `主应力 sigma1=${r.principal.sigma1.toFixed(6)} sigma2=${r.principal.sigma2.toFixed(6)} 状态=${r.principal.status}`
    );
    if (r.principal.theta1Deg !== null) {
      console.log(
        `主方向 theta1=${r.principal.theta1Deg.toFixed(4)}° theta2=${r.principal.theta2Deg?.toFixed(4)}° ` +
          `代回剪应力残差=${r.principal.tauResidual1.toExponential(3)}`
      );
    } else {
      console.log("主方向不唯一（各向同性），唯一角度为空");
    }
    for (const f of r.maxShear.faces) {
      console.log(
        `最大剪应力面 法向=${f.normalDeg.toFixed(3)}° 有符号tau=${f.tau.toFixed(4)} sigma=${f.sigma.toFixed(4)}`
      );
    }
    for (const q of r.queries) {
      console.log(
        `θ=${q.thetaDeg}° -> σn=${q.sigmaN.toFixed(4)} τn=${q.tauN.toFixed(4)} ` +
          `牵引=(${q.traction.x.toFixed(3)},${q.traction.y.toFixed(3)}) 回代残差=${q.residual.toExponential(2)}`
      );
    }
  }
}

function main(argv: string[]): void {
  const cmd = argv[0];
  const args = argv.slice(1);
  const db = openDatabase(DB_PATH);
  try {
    switch (cmd) {
      case "save": {
        const req: CreateRequest = {
          sigmaX: Number(argValue(args, "--sx")),
          sigmaY: Number(argValue(args, "--sy")),
          tauXY: Number(argValue(args, "--txy")),
          angles: argValue(args, "--angles")
            ?.split(",")
            .map((s) => Number(s.trim())),
          idemKey: argValue(args, "--idem") ?? null,
        };
        const created = createReport(db, req);
        console.log(`${created.inserted ? "已保存" : "已存在（幂等）"}: ${created.id}`);
        printJson(created.report);
        break;
      }
      case "get": {
        const r = loadReport(db, args[0]);
        if (!r) throw new ValidationError("工况不存在", "NOT_FOUND");
        printJson(r);
        break;
      }
      case "list": {
        const rows = db
          .prepare("SELECT id, input_json, created_at FROM cases ORDER BY created_at")
          .all();
        printJson(rows);
        break;
      }
      case "principal": {
        const r = loadReport(db, args[0]);
        if (!r) throw new ValidationError("工况不存在", "NOT_FOUND");
        printJson(r.principal);
        break;
      }
      case "mohr": {
        const r = loadReport(db, args[0]);
        if (!r) throw new ValidationError("工况不存在", "NOT_FOUND");
        printJson(r.mohr);
        break;
      }
      case "compare": {
        const a = loadReport(db, args[0]);
        const b = loadReport(db, args[1]);
        if (!a || !b) throw new ValidationError("工况不存在", "NOT_FOUND");
        printJson({
          sigma1: [a.principal.sigma1, b.principal.sigma1],
          sigma2: [a.principal.sigma2, b.principal.sigma2],
          deltaSigma1: b.principal.sigma1 - a.principal.sigma1,
          deltaSigma2: b.principal.sigma2 - a.principal.sigma2,
          deltaRadius: b.principal.radius - a.principal.radius,
        });
        break;
      }
      case "export": {
        const r = loadReport(db, args[0]);
        if (!r) throw new ValidationError("工况不存在", "NOT_FOUND");
        const format = argValue(args, "--format") ?? "json";
        const content = format === "csv" ? toCsv(r) : JSON.stringify(r, null, 2);
        const out = argValue(args, "--out");
        if (out) {
          writeFileSync(out, content, "utf8");
          console.log(`已导出到 ${out}`);
        } else {
          console.log(content);
        }
        break;
      }
      case "demo":
        demo(db);
        break;
      default:
        usage();
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      console.error(`错误[${err.code}]: ${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}
