/** Yearning REST / WebSocket API 逐接口封装 */

import { YearningClientBase } from "./base.js";
import { YearningApiError } from "./errors.js";
import { wsJson, wsQuery } from "./ws.js";

export interface OrderListExpr {
  text?: string;
  status?: number;
  work_id?: string;
  order_type?: number;
}

export class YearningClient extends YearningClientBase {
  // ---------- 元数据 ----------
  async userInfo(): Promise<Record<string, unknown>> {
    return (await this.request("GET", "/fetch/userinfo")) as Record<string, unknown>;
  }

  async listSources(tp = "all"): Promise<unknown[]> {
    return (await this.request("GET", "/fetch/source", {
      jsonBody: { tp },
    })) as unknown[];
  }

  async listDatabases(sourceId: string, hide = false): Promise<unknown[]> {
    return (await this.request("GET", "/fetch/base", {
      jsonBody: { source_id: sourceId, hide },
    })) as unknown[];
  }

  async listTables(sourceId: string, database: string): Promise<unknown[]> {
    return (await this.request("GET", "/fetch/table", {
      jsonBody: { source_id: sourceId, data_base: database },
    })) as unknown[];
  }

  async tableFields(
    sourceId: string,
    database: string,
    table: string,
  ): Promise<Record<string, unknown>> {
    return (await this.request("GET", "/fetch/fields", {
      jsonBody: { source_id: sourceId, data_base: database, table },
    })) as Record<string, unknown>;
  }

  /** kind: 0=DDL, 1=DML */
  async sqlCheck(
    sourceId: string,
    database: string,
    sql: string,
    kind: number,
  ): Promise<unknown[]> {
    return (await this.request("PUT", "/fetch/test", {
      jsonBody: {
        source_id: sourceId,
        data_base: database,
        sql,
        kind,
      },
    })) as unknown[];
  }

  // ---------- SQL 工单 ----------
  async submitOrder(order: Record<string, unknown>): Promise<string> {
    // 对齐前端 orderItems：补齐 idc/source/relevant/delay 等字段，避免审核流异常
    const sourceId = String(order.source_id || "");
    let idc = order.idc;
    let source = order.source;
    let relevant = order.relevant;

    if (!idc || !source) {
      const sources = await this.listSources("all");
      const hit = sources.find((s) => {
        const row = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
        return String(row.source_id) === sourceId;
      }) as Record<string, unknown> | undefined;
      if (hit) {
        idc = idc || hit.idc || hit.id_c || "";
        source = source || hit.source || "";
      }
    }

    if (!Array.isArray(relevant) || relevant.length === 0) {
      const timeline = (await this.request("GET", "/fetch/timeline", {
        params: { source_id: sourceId, work_id: "" },
      })) as unknown[];
      const auditors: string[] = [];
      for (const step of Array.isArray(timeline) ? timeline : []) {
        const row = step && typeof step === "object" ? (step as Record<string, unknown>) : {};
        if (Array.isArray(row.auditor)) {
          for (const a of row.auditor) auditors.push(String(a));
        }
      }
      relevant = [...new Set(auditors)];
    }

    const body = {
      type: order.type,
      idc: idc || "",
      source: source || "",
      source_id: sourceId,
      data_base: order.data_base,
      table: order.table || "",
      text: order.text,
      delay: order.delay ?? "",
      backup: order.backup ?? 0,
      sql: order.sql,
      relevant,
      work_id: order.work_id || "",
      ...(order.assigned !== undefined ? { assigned: order.assigned } : {}),
      ...(order.execute_time !== undefined
        ? { execute_time: order.execute_time }
        : {}),
    };

    return (await this.request("POST", "/common/post", {
      jsonBody: body,
    })) as string;
  }

  async myOrders(
    current: number,
    pageSize: number,
    expr: OrderListExpr = {},
  ): Promise<Record<string, unknown>> {
    // Yearning 前端默认 expr.type=2 表示全部；不传 type 时服务端常按 DDL(0) 过滤
    const bodyExpr: Record<string, unknown> = {
      status: expr.status ?? 8,
      type: expr.order_type ?? 2,
      text: expr.text ?? "",
      username: "",
    };
    if (expr.work_id !== undefined) bodyExpr.work_id = expr.work_id;

    return (await wsJson(this, "/common/list", {
      payload: {
        current,
        pageSize,
        expr: bodyExpr,
        page: 0,
        data: [],
      },
    })) as Record<string, unknown>;
  }

  async orderDetail(
    workId: string,
    page = 1,
    pageSize = 10,
  ): Promise<Record<string, unknown>> {
    const detail = await this.request("GET", "/fetch/detail", {
      jsonBody: { work_id: workId, page, page_size: pageSize },
    });
    const sqls = await this.request("GET", "/fetch/sql", {
      params: { work_id: workId },
    });
    return { detail, sql: sqls };
  }

  async orderTimeline(
    workId: string,
    sourceId?: string,
  ): Promise<Record<string, unknown>> {
    const params: Record<string, string> = { work_id: workId };
    if (sourceId) params.source_id = sourceId;
    const steps = await this.request("GET", "/fetch/timeline", { params });
    const profile = await this.request("GET", "/fetch/steps", {
      params: { work_id: workId },
    });
    return { steps, profile };
  }

  async rollbackSql(workId: string): Promise<Record<string, unknown>> {
    return (await this.request("GET", "/fetch/roll", {
      params: { work_id: workId },
    })) as Record<string, unknown>;
  }

  async undoOrder(workId: string): Promise<string> {
    return (await this.request("GET", "/fetch/undo", {
      params: { work_id: workId },
    })) as string;
  }

  async auditOrders(
    current: number,
    pageSize: number,
    expr: OrderListExpr = {},
  ): Promise<Record<string, unknown>> {
    const bodyExpr: Record<string, unknown> = {
      status: expr.status ?? 8,
      type: expr.order_type ?? 2,
      text: expr.text ?? "",
      username: "",
    };
    if (expr.work_id !== undefined) bodyExpr.work_id = expr.work_id;

    return (await wsJson(this, "/audit/order/list", {
      payload: {
        current,
        pageSize,
        expr: bodyExpr,
        page: 0,
        data: [],
      },
    })) as Record<string, unknown>;
  }

  /** body.tp: agree / reject / undo */
  async auditOrder(body: Record<string, unknown>): Promise<string> {
    return (await this.request("POST", "/audit/order/state", {
      jsonBody: body,
    })) as string;
  }

  // ---------- 查询 ----------
  async queryStatus(): Promise<Record<string, unknown>> {
    const isQuery = await this.request("GET", "/fetch/is_query");
    const myStatus = await this.request("GET", "/fetch/query_status");
    return { is_query_open: isQuery, my_query_status: myStatus };
  }

  async submitQueryOrder(
    sourceId: string,
    text: string,
    exportFlag = 0,
  ): Promise<string> {
    return (await this.request("POST", "/query/post", {
      jsonBody: { source_id: sourceId, export: exportFlag, text },
    })) as string;
  }

  async runQuery(
    sourceId: string,
    schema: string,
    sql: string,
  ): Promise<Record<string, unknown>> {
    const data = await wsQuery(this, sourceId, sql, schema);
    if (data.error) {
      throw new YearningApiError(String(data.error));
    }
    return data;
  }

  async orderComments(workId: string): Promise<unknown[]> {
    return (await wsJson(this, "/fetch/comment", {
      query: { work_id: workId },
      payload: {},
    })) as unknown[];
  }

  async postComment(workId: string, content: string): Promise<string> {
    return (await this.request("POST", "/fetch/comment", {
      jsonBody: { work_id: workId, content },
    })) as string;
  }
}
