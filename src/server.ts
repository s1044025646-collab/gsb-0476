import * as http from "node:http";
import { AddressInfo } from "node:net";
import { Store } from "./db";
import { ApiError, MAX_BATCH_ANGLES } from "./core/stress";
import { parseAngles, queryFaces, fullReport, compareCases, reportToCsv } from "./report";
import { principals, maxInPlaneShear, mohrCircle } from "./core/stress";
import { stateOf } from "./db";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof ApiError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message } });
  } else {
    sendJson(res, 500, { error: { code: "INTERNAL", message: String(err) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new ApiError("LIMIT_EXCEEDED", "请求体超过 1MB 上限", 413);
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw new ApiError("INVALID_INPUT", "请求体不是合法 JSON");
  }
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/api/health") {
        return sendJson(res, 200, { ok: true, service: "stress-mohr-backend" });
      }

      if (method === "POST" && url.pathname === "/api/cases") {
        const body = await readBody(req);
        const { record, existed } = store.createCase(body);
        return sendJson(res, existed ? 200 : 201, { case: record, existed });
      }

      if (method === "GET" && url.pathname === "/api/cases") {
        return sendJson(res, 200, { cases: store.listCases() });
      }

      if (parts[0] === "api" && parts[1] === "cases" && parts.length >= 3) {
        const rec = store.requireCase(parts[2]);
        const sub = parts[3];

        if (method === "GET" && parts.length === 3) {
          return sendJson(res, 200, { case: rec });
        }
        if (method === "GET" && sub === "report") {
          const angles = url.searchParams.get("angles");
          const list = angles ? parseAngles(angles.split(",").map(Number)) : undefined;
          return sendJson(res, 200, fullReport(rec, list));
        }
        if (method === "GET" && sub === "principals") {
          const state = stateOf(rec);
          return sendJson(res, 200, {
            caseId: rec.id,
            principals: principals(state, rec.tolerance),
            maxInPlaneShear: maxInPlaneShear(state, rec.tolerance),
          });
        }
        if (method === "POST" && sub === "query") {
          const body = await readBody(req);
          return sendJson(res, 200, queryFaces(rec, parseAngles(body.angles)));
        }
        if (method === "GET" && sub === "mohr") {
          const angles = url.searchParams.get("angles");
          const list = angles
            ? parseAngles(angles.split(",").map(Number))
            : Array.from({ length: 37 }, (_, i) => i * 5);
          if (list.length > MAX_BATCH_ANGLES) throw new ApiError("LIMIT_EXCEEDED", "角度过多");
          return sendJson(res, 200, { caseId: rec.id, mohr: mohrCircle(stateOf(rec), list) });
        }
        if (method === "GET" && sub === "export") {
          const format = url.searchParams.get("format") ?? "json";
          const angles = url.searchParams.get("angles");
          const list = angles ? parseAngles(angles.split(",").map(Number)) : [0, 30, 45, 60, 90];
          if (format === "csv") {
            res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
            return res.end(reportToCsv(rec, list));
          }
          if (format === "json") {
            return sendJson(res, 200, fullReport(rec, list));
          }
          throw new ApiError("INVALID_INPUT", "format 仅支持 json 或 csv");
        }
      }

      if (method === "POST" && url.pathname === "/api/compare") {
        const body = await readBody(req);
        if (!Array.isArray(body.ids) || body.ids.length !== 2) {
          throw new ApiError("INVALID_INPUT", "ids 必须是两个工况 id 的数组");
        }
        const a = store.requireCase(String(body.ids[0]));
        const b = store.requireCase(String(body.ids[1]));
        return sendJson(res, 200, compareCases(a, b));
      }

      throw new ApiError("NOT_FOUND", `路由不存在: ${method} ${url.pathname}`, 404);
    } catch (err) {
      sendError(res, err);
    }
  });
}

/** 启动服务；port=0 时由系统分配空闲端口（默认）。 */
export function startServer(store: Store, port = 0): Promise<{ server: http.Server; port: number }> {
  const server = createServer(store);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}
