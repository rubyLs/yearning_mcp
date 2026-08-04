/**
 * Yearning WebSocket 一次性请求封装。
 *
 * - 鉴权：Sec-WebSocket-Protocol 携带裸 JWT
 * - Origin：golang websocket.Handler 强制校验 Origin，必须与 base_url 一致
 * - 列表类 JSON；查询执行 msgpack
 */

import { pack, unpack } from "msgpackr";
import WebSocket from "ws";
import type { YearningClientBase } from "./base.js";
import { YearningApiError } from "./errors.js";

const WS_PREFIX = "/api/v2";

function toWsBaseUrl(baseUrl: string): string {
  if (baseUrl.startsWith("https://")) return "wss://" + baseUrl.slice("https://".length);
  if (baseUrl.startsWith("http://")) return "ws://" + baseUrl.slice("http://".length);
  return baseUrl;
}

function parseEnvelope(data: unknown): unknown {
  if (data && typeof data === "object" && "code" in data) {
    const env = data as { payload?: unknown; code?: number; text?: string };
    const code = env.code ?? 5555;
    if (code !== 1200) {
      throw new YearningApiError(env.text || "未知错误", code);
    }
    return env.payload !== undefined && env.payload !== null
      ? env.payload
      : env.text || "";
  }
  return data;
}

function connectOnce(
  url: string,
  token: string,
  origin: string,
  timeoutMs: number,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, [token], {
      origin,
      handshakeTimeout: timeoutMs,
    });

    const timer = setTimeout(() => {
      ws.terminate();
      reject(
        new YearningApiError(
          "连接 Yearning WebSocket 超时。常见原因：YEARNING_URL 不可达或服务未启动。",
          408,
        ),
      );
    }, timeoutMs);

    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(
        new YearningApiError(
          `连接 Yearning WebSocket 失败（${err.message}）。` +
            "常见原因：YEARNING_URL 不可达、token 失效、或 Yearning 服务未启动。",
        ),
      );
    });
  });
}

function recvOnce(ws: WebSocket, timeoutMs: number, binary: boolean): Promise<Buffer | string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      ws.terminate();
      reject(
        new YearningApiError(
          "Yearning 在限定时间内未返回数据（WebSocket 接收超时）。" +
            "常见原因：无该数据源查询/列表权限、查询审核未批准、或 Yearning 无响应。",
          408,
        ),
      );
    }, timeoutMs);

    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      cleanup();
      if (binary || isBinary) {
        resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      } else {
        resolve(typeof data === "string" ? data : data.toString("utf8"));
      }
    };
    const onClose = () => {
      cleanup();
      reject(
        new YearningApiError(
          "Yearning 在返回数据前即关闭了 WebSocket 连接。" +
            "常见原因：无该数据源权限 / 查询审核未批准 / token 失效 / 传入参数不合法。",
        ),
      );
    };
    const onError = (err: Error) => {
      cleanup();
      reject(new YearningApiError(`WebSocket 错误：${err.message}`));
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    };

    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

export async function wsJson(
  client: YearningClientBase,
  path: string,
  options: {
    query?: Record<string, string>;
    payload?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<unknown> {
  const token = await client.ensureToken();
  const timeoutMs = options.timeoutMs ?? client.timeoutMs;
  let url = `${toWsBaseUrl(client.baseUrl)}${WS_PREFIX}${path}`;
  if (options.query && Object.keys(options.query).length > 0) {
    url += `?${new URLSearchParams(options.query).toString()}`;
  }

  const ws = await connectOnce(url, token, client.baseUrl, timeoutMs);
  try {
    if (options.payload !== undefined) {
      ws.send(JSON.stringify(options.payload));
    }
    const raw = await recvOnce(ws, timeoutMs, false);
    return parseEnvelope(JSON.parse(String(raw)));
  } finally {
    ws.close();
  }
}

export async function wsQuery(
  client: YearningClientBase,
  sourceId: string,
  sql: string,
  schema: string,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const token = await client.ensureToken();
  const timeout = timeoutMs ?? client.timeoutMs;
  const url =
    `${toWsBaseUrl(client.baseUrl)}${WS_PREFIX}/query/results?` +
    new URLSearchParams({ source_id: sourceId }).toString();

  const ws = await connectOnce(url, token, client.baseUrl, timeout);
  try {
    // 键名对应 Yearning QueryDeal.Ref 的 Go 字段
    ws.send(pack({ type: 0, sql, schema }));
    const raw = await recvOnce(ws, timeout, true);
    const data = unpack(raw as Buffer) as unknown;
    if (!data || typeof data !== "object") {
      throw new YearningApiError(
        `WebSocket 返回数据格式异常：期望 object，得到 ${typeof data}`,
      );
    }
    const obj = data as Record<string, unknown>;
    if (obj.status && !obj.results && !obj.error) {
      throw new YearningApiError(
        "查询未返回数据：当前用户没有有效（已批准且未过期）的查询工单。" +
          "请先通过 yearning_submit_query_order 提交查询申请" +
          "（审核关闭时会自动批准，开启时需审核人批准）后重试。",
      );
    }
    return obj;
  } finally {
    ws.close();
  }
}
