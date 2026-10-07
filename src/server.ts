import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db";
import { ValidationError } from "./core";
import {
  compareReports,
  createReport,
  loadReport,
  toCsv,
} from "./service";

const DATA_DIR = process.env.STRESS_DATA_DIR ?? join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "stress.db");

export function pickFreePort(preferred = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.on("error", reject);
    srv.listen(preferred, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("无法获取空闲端口"));
      });
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string
): void {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new ValidationError("请求体超过 1MB 上限", "BODY_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ValidationError("请求体不是合法 JSON", "INVALID_JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createApp(db: DatabaseSync): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/health") {
        return sendJson(res, 200, { ok: true, scope: "plane-stress-2d" });
      }

      if (method === "POST" && path === "/cases") {
        const body = await readBody(req);
        const created = createReport(db, body);
        return sendJson(res, created.inserted ? 201 : 200, {
          id: created.id,
          inserted: created.inserted,
          report: created.report,
        });
      }

      const caseMatch = path.match(/^\/cases\/([^/]+)$/);
      if (method === "GET" && caseMatch) {
        const report = loadReport(db, decodeURIComponent(caseMatch[1]));
        if (!report) return sendError(res, 404, "NOT_FOUND", "工况不存在");
        return sendJson(res, 200, report);
      }

      const csvMatch = path.match(/^\/cases\/([^/]+)\/export$/);
      if (method === "GET" && csvMatch) {
        const report = loadReport(db, decodeURIComponent(csvMatch[1]));
        if (!report) return sendError(res, 404, "NOT_FOUND", "工况不存在");
        const format = url.searchParams.get("format") ?? "json";
        if (format === "csv") {
          const csv = toCsv(report);
          res.writeHead(200, {
            "Content-Type": "text/csv; charset=utf-8",
          });
          return res.end(csv);
        }
        return sendJson(res, 200, report);
      }

      if (method === "GET" && path === "/cases") {
        const rows = db
          .prepare("SELECT id, input_json, created_at FROM cases ORDER BY created_at")
          .all();
        return sendJson(res, 200, { cases: rows });
      }

      const compareMatch = path.match(
        /^\/compare\/([^/]+)\/([^/]+)$/
      );
      if (method === "GET" && compareMatch) {
        const a = loadReport(db, decodeURIComponent(compareMatch[1]));
        const b = loadReport(db, decodeURIComponent(compareMatch[2]));
        if (!a || !b)
          return sendError(res, 404, "NOT_FOUND", "参与比较的工况不存在");
        return sendJson(res, 200, compareReports(a, b));
      }

      return sendError(res, 404, "NOT_FOUND", `未知路由 ${method} ${path}`);
    } catch (err) {
      if (err instanceof ValidationError) {
        return sendError(res, 400, err.code, err.message);
      }
      return sendError(res, 500, "INTERNAL_ERROR", (err as Error).message);
    }
  });
}

async function main(): Promise<void> {
  const requested = process.env.PORT ? Number(process.env.PORT) : 0;
  if (process.env.PORT && (!Number.isInteger(requested) || requested < 0)) {
    throw new Error("PORT 必须为非负整数（0 表示自动选择空闲端口）");
  }
  const db = openDatabase(DB_PATH);
  const port = await pickFreePort(requested);
  const server = createApp(db);
  server.listen(port, "127.0.0.1", () => {
    console.log(`平面应力服务已启动: http://127.0.0.1:${port}`);
    console.log(`数据目录: ${DATA_DIR}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
