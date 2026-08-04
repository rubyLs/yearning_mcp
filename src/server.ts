/**
 * Yearning MCP Server：注册工具与资源。
 * 覆盖元数据浏览、SQL 工单提交/审核/撤回、查询申请与只读查询。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import {
  getYearningClient,
  YearningApiError,
  YearningAuthError,
  type YearningClient,
} from "./clients/index.js";
import { renderKv, renderList, toJson } from "./render.js";

const ORDER_STATUS: Record<number, string> = {
  0: "已驳回",
  1: "执行中",
  2: "待审核",
  3: "已执行/完成",
  4: "已终止",
  5: "待执行",
  6: "已撤回",
};

const ORDER_TYPE_TEXT: Record<number, string> = { 0: "DDL", 1: "DML" };
const ORDER_TYPE_MAP = { ddl: 0, dml: 1 } as const;

const ResponseFormat = z.enum(["markdown", "json"]).default("markdown");

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

function handleError(e: unknown): string {
  if (e instanceof YearningAuthError) return `错误：${e.message}`;
  if (e instanceof YearningApiError) {
    if (e.code === 401) {
      return "错误：认证失败，请检查 YEARNING_USERNAME / YEARNING_PASSWORD 是否正确";
    }
    if (e.code === 403) {
      return `错误：权限不足（当前账号非 admin 或不在审核人/相关人列表中）。详情：${e.message}`;
    }
    if (e.code === 5555 && e.message.toLowerCase().includes("illegal")) {
      return "错误：该接口在当前 Yearning 版本不支持，请确认服务端版本。";
    }
    return `错误：Yearning 请求失败（业务码 ${e.code}）：${e.message}`;
  }
  if (e instanceof Error) return `错误：${e.name}: ${e.message}`;
  return `错误：${String(e)}`;
}

function statusText(value: unknown): string {
  try {
    return ORDER_STATUS[Number(value)] ?? String(value);
  } catch {
    return String(value);
  }
}

function orderTypeText(value: unknown): unknown {
  try {
    return ORDER_TYPE_TEXT[Number(value)] ?? value;
  } catch {
    return value;
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function renderOrderList(title: string, payload: Record<string, unknown>): string {
  const rows = asArray(payload.data).map((r) => {
    const row = { ...asRecord(r) };
    if ("status" in row) row.status_text = statusText(row.status);
    if ("type" in row) row.type_text = orderTypeText(row.type);
    return row;
  });
  return renderList(
    title,
    rows,
    [
      ["work_id", "工单号"],
      ["text", "说明"],
      ["source", "数据源"],
      ["data_base", "库"],
      ["type_text", "类型"],
      ["status_text", "状态"],
      ["date", "提交时间"],
      ["real_name", "提交人"],
      ["assigned", "当前审核人"],
    ],
    payload.page,
  );
}

function ro(title: string) {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
}

function rw(title: string, opts: { destructive?: boolean; idempotent?: boolean } = {}) {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: !!opts.destructive,
    idempotentHint: !!opts.idempotent,
    openWorldHint: true,
  };
}

export function createServer(config: AppConfig): McpServer {
  const client = (): YearningClient => getYearningClient(config.yearning);

  const server = new McpServer(
    {
      name: "yearning_mcp",
      version: "1.0.0",
    },
    {
      instructions:
        "Yearning SQL 审核平台 MCP Server。" +
        "提供 SQL 工单提交/审核/撤回、数据查询、表结构查看等工具。" +
        "提交流程建议：yearning_sql_check → yearning_submit_order → yearning_audit_order。" +
        (config.yearning.readOnly
          ? "当前为只读模式，写工具未注册。"
          : "写工具已启用（YEARNING_READ_ONLY=false）。"),
    },
  );

  // ---------- Resources ----------
  server.registerResource(
    "user-info",
    "yearning://user-info",
    {
      title: "当前用户信息",
      description: "当前登录用户信息（已脱敏）与可查询数据源",
      mimeType: "application/json",
    },
    async () => {
      try {
        const data = await client().userInfo();
        const userRaw = data.user && typeof data.user === "object" ? data.user : data;
        const user = Object.fromEntries(
          Object.entries(asRecord(userRaw)).filter(
            ([k]) => k !== "password" && k !== "query_password",
          ),
        );
        return {
          contents: [
            {
              uri: "yearning://user-info",
              mimeType: "application/json",
              text: toJson({ user, sources: data.source || [] }),
            },
          ],
        };
      } catch (e) {
        return {
          contents: [
            {
              uri: "yearning://user-info",
              mimeType: "text/plain",
              text: handleError(e),
            },
          ],
        };
      }
    },
  );

  server.registerResource(
    "sources",
    "yearning://sources",
    {
      title: "数据源列表",
      description: "当前账号有权限的数据源",
      mimeType: "application/json",
    },
    async () => {
      try {
        const data = await client().listSources("all");
        return {
          contents: [
            {
              uri: "yearning://sources",
              mimeType: "application/json",
              text: toJson(data),
            },
          ],
        };
      } catch (e) {
        return {
          contents: [
            {
              uri: "yearning://sources",
              mimeType: "text/plain",
              text: handleError(e),
            },
          ],
        };
      }
    },
  );

  // ---------- 只读：元数据 ----------
  server.registerTool(
    "yearning_user_info",
    {
      title: "查看当前用户信息",
      description:
        "查看当前登录用户信息、部门、邮箱，以及有权查询的数据源列表。对应 GET /api/v2/fetch/userinfo",
      inputSchema: { response_format: ResponseFormat },
      annotations: ro("查看当前用户信息"),
    },
    async ({ response_format }) => {
      try {
        const data = await client().userInfo();
        const userRaw = data.user && typeof data.user === "object" ? data.user : data;
        const user = Object.fromEntries(
          Object.entries(asRecord(userRaw)).filter(
            ([k]) => k !== "password" && k !== "query_password",
          ),
        );
        const sources = asArray(data.source);
        if (response_format === "json") {
          return ok(toJson({ user, sources }));
        }
        const lines = [renderKv("用户信息", user)];
        if (sources.length) {
          lines.push(
            renderList(
              "可查询数据源",
              sources,
              [
                ["source_id", "数据源ID"],
                ["source", "名称"],
              ],
              sources.length,
            ),
          );
        }
        return ok(lines.join("\n\n"));
      } catch (e) {
        return fail(handleError(e));
      }
    },
  );

  server.registerTool(
    "yearning_list_sources",
    {
      title: "列出数据源",
      description:
        "列出当前账号有权限的数据源（可按 query/dml/ddl/idc 过滤）。对应 GET /api/v2/fetch/source",
      inputSchema: {
        tp: z
          .enum(["all", "query", "dml", "ddl", "idc"])
          .default("all")
          .describe("数据源范围"),
        response_format: ResponseFormat,
      },
      annotations: ro("列出数据源"),
    },
    async ({ tp, response_format }) => {
      try {
        const data = await client().listSources(tp);
        if (response_format === "json") return ok(toJson(data));
        return ok(
          renderList(
            "数据源列表",
            data,
            [
              ["source_id", "数据源ID"],
              ["source", "名称"],
              ["id_c", "IDC"],
            ],
            data.length,
          ),
        );
      } catch (e) {
        return fail(handleError(e));
      }
    },
  );

  server.registerTool(
    "yearning_list_databases",
    {
      title: "列出库",
      description: "列出指定数据源下的数据库列表。对应 GET /api/v2/fetch/base",
      inputSchema: {
        source_id: z.string().describe("数据源 ID（来自 yearning_list_sources）"),
        hide: z.boolean().default(false).describe("是否隐藏排除库列表"),
        response_format: ResponseFormat,
      },
      annotations: ro("列出库"),
    },
    async ({ source_id, hide, response_format }) => {
      try {
        const data = await client().listDatabases(source_id, hide);
        if (response_format === "json") return ok(toJson(data));
        const rows = data.map((d) => ({ database: d }));
        return ok(renderList("库列表", rows, [["database", "库名"]], rows.length));
      } catch (e) {
        return fail(handleError(e));
      }
    },
  );

  server.registerTool(
    "yearning_list_tables",
    {
      title: "列出表",
      description: "列出指定数据源、指定库下的表。对应 GET /api/v2/fetch/table",
      inputSchema: {
        source_id: z.string().describe("数据源 ID"),
        database: z.string().describe("库名"),
        response_format: ResponseFormat,
      },
      annotations: ro("列出表"),
    },
    async ({ source_id, database, response_format }) => {
      try {
        const data = await client().listTables(source_id, database);
        if (response_format === "json") return ok(toJson(data));
        const rows = data.map((t) => ({ table: t }));
        return ok(
          renderList(`表列表（${database}）`, rows, [["table", "表名"]], rows.length),
        );
      } catch (e) {
        return fail(handleError(e));
      }
    },
  );

  server.registerTool(
    "yearning_table_fields",
    {
      title: "查看表结构",
      description:
        "查看表结构：字段列表（类型/可空/键/默认值/注释）与索引。对应 GET /api/v2/fetch/fields",
      inputSchema: {
        source_id: z.string().describe("数据源 ID"),
        database: z.string().describe("库名"),
        table: z.string().describe("表名"),
        response_format: ResponseFormat,
      },
      annotations: ro("查看表结构"),
    },
    async ({ source_id, database, table, response_format }) => {
      try {
        const data = await client().tableFields(source_id, database, table);
        if (response_format === "json") return ok(toJson(data));
        const rows = asArray(data.rows);
        const idx = asArray(data.idx);
        return ok(
          [
            renderList(
              `字段（${table}）`,
              rows,
              [
                ["field", "字段"],
                ["type", "类型"],
                ["null", "可空"],
                ["key", "键"],
                ["default", "默认值"],
                ["extra", "额外"],
                ["comment", "注释"],
              ],
              rows.length,
            ),
            "",
            renderList(
              "索引",
              idx,
              [
                ["Table", "表"],
                ["Key_name", "索引名"],
                ["Column_name", "列"],
                ["Non_unique", "唯一"],
                ["Index_type", "类型"],
              ],
              idx.length,
            ),
          ].join("\n"),
        );
      } catch (e) {
        return fail(handleError(e));
      }
    },
  );

  server.registerTool(
    "yearning_sql_check",
    {
      title: "SQL 审核检测",
      description:
        "提交前对 SQL 做审核检测。建议先调用本工具，再 yearning_submit_order。对应 PUT /api/v2/fetch/test。不接受 SELECT（请用 yearning_run_query）。",
      inputSchema: {
        source_id: z.string().describe("数据源 ID"),
        database: z.string().describe("库名"),
        sql: z.string().describe("待检测 SQL"),
        order_type: z.enum(["ddl", "dml"]).describe("SQL 类型"),
        response_format: ResponseFormat,
      },
      annotations: ro("SQL 审核检测"),
    },
    async ({ source_id, database, sql, order_type, response_format }) => {
      try {
        const data = await client().sqlCheck(
          source_id,
          database,
          sql,
          ORDER_TYPE_MAP[order_type],
        );
        if (response_format === "json") return ok(toJson(data));
        if (!data.length) return ok("✅ SQL 检查通过，未发现风险。");
        const levelMark: Record<number, string> = { 0: "✅", 1: "⚠️", 2: "❌" };
        const lines = [`# SQL 检查（共 ${data.length} 条）`, ""];
        data.forEach((item, i) => {
          const r = asRecord(item);
          const lvl = Number(r.level ?? 0);
          lines.push(`## 第 ${i + 1} 条 ${levelMark[lvl] ?? ""} 级别 ${lvl}`, "");
          lines.push(
            renderKv("", {
              sql: r.sql,
              status: r.status,
              error: r.error,
              affect_rows: r.affect_rows,
              exec_time: r.exec_time,
              table: r.table,
              schema: r.schema,
            }),
            "",
          );
        });
        return ok(lines.join("\n").trimEnd());
      } catch (e) {
        return fail(handleError(e));
      }
    },
  );

  // ---------- 只读：工单 ----------
  server.registerTool(
    "yearning_my_orders",
    {
      title: "我的工单列表",
      description:
        "分页列出当前用户提交的工单。状态：8=全部 / 2=待审核 / 3=已完成 / 0=已驳回 / 4=已终止 / 6=已撤回 / 1=执行中 / 5=待执行。对应 WS /api/v2/common/list",
      inputSchema: {
        page: z.number().int().min(1).default(1).describe("页码（从 1 开始）"),
        page_size: z.number().int().min(1).max(100).default(10).describe("分页大小"),
        status: z
          .number()
          .int()
          .default(8)
          .describe("状态过滤，8=全部"),
        text: z.string().optional().describe("按说明/工单号模糊搜索"),
        work_id: z.string().optional().describe("按工单号过滤"),
        response_format: ResponseFormat,
      },
      annotations: ro("我的工单列表"),
    },
    async ({ page, page_size, status, text, work_id, response_format }) => {
      try {
        const data = await client().myOrders(page, page_size, {
          text,
          status,
          work_id,
        });
        if (response_format === "json") return ok(toJson(data));
        return ok(renderOrderList(`我的工单（第 ${page} 页）`, data));
      } catch (e) {
        return fail(handleError(e));
      }
    },
  );

  server.registerTool(
    "yearning_order_detail",
    {
      title: "工单详情",
      description:
        "查看工单详情：SQL 明细与完整 SQL。对应 GET /api/v2/fetch/detail + /fetch/sql",
      inputSchema: {
        work_id: z.string().describe("工单号"),
        page: z.number().int().min(1).default(1),
        page_size: z.number().int().min(1).max(100).default(10),
        response_format: ResponseFormat,
      },
      annotations: ro("工单详情"),
    },
    async ({ work_id, page, page_size, response_format }) => {
      try {
        const data = await client().orderDetail(work_id, page, page_size);
        if (response_format === "json") return ok(toJson(data));
        const detail = asRecord(data.detail);
        const records = asArray(detail.record);
        const sqls = String(asRecord(data.sql).sqls || "");
        return ok(
          [
            `# 工单 ${work_id} 详情`,
            "",
            "## 完整 SQL",
            "",
            sqls ? `\`\`\`sql\n${sqls}\n\`\`\`` : "（无 SQL）",
            "",
            renderList(
              `SQL 明细（共 ${detail.count} 条）`,
              records,
              [
                ["sql", "SQL"],
                ["affect_rows", "影响行数"],
                ["exec_time", "执行耗时"],
                ["status", "状态"],
                ["error", "错误"],
              ],
              detail.count,
            ),
          ].join("\n"),
        );
      } catch (e) {
        return fail(handleError(e));
      }
    },
  );

  server.registerTool(
    "yearning_order_timeline",
    {
      title: "工单审核时间线",
      description:
        "查看工单审核时间线与流程步骤。审核时 flag 取自此处。对应 GET /api/v2/fetch/timeline + /fetch/steps",
      inputSchema: {
        work_id: z.string().describe("工单号"),
        source_id: z.string().optional().describe("数据源 ID（影响流程步骤解析）"),
        response_format: ResponseFormat,
      },
      annotations: ro("工单审核时间线"),
    },
    async ({ work_id, source_id, response_format }) => {
      try {
        const data = await client().orderTimeline(work_id, source_id);
        if (response_format === "json") return ok(toJson(data));
        const steps = asArray(data.steps);
        const profile = asArray(data.profile);
        return ok(
          [
            renderList(
              "流程步骤",
              steps,
              [
                ["desc", "步骤说明"],
                ["auditor", "审核人"],
                ["action", "动作"],
                ["username", "操作人"],
                ["time", "时间"],
              ],
              steps.length,
            ),
            "",
            renderList(
              "操作记录",
              profile,
              [
                ["username", "操作人"],
                ["action", "动作"],
                ["time", "时间"],
              ],
              profile.length,
            ),
          ].join("\n"),
        );
      } catch (e) {
        return fail(handleError(e));
      }
    },
  );

  server.registerTool(
    "yearning_rollback_sql",
    {
      title: "回滚 SQL",
      description: "获取工单的回滚 SQL。对应 GET /api/v2/fetch/roll",
      inputSchema: {
        work_id: z.string().describe("工单号"),
        response_format: ResponseFormat,
      },
      annotations: ro("回滚 SQL"),
    },
    async ({ work_id, response_format }) => {
      try {
        const data = await client().rollbackSql(work_id);
        if (response_format === "json") return ok(toJson(data));
        const sqls = asArray(data.sql);
        if (!sqls.length) {
          return ok(`工单 ${work_id} 暂无回滚 SQL（可能尚未执行或无需回滚）。`);
        }
        const lines = [`# 工单 ${work_id} 回滚 SQL（共 ${data.count} 条）`, ""];
        sqls.forEach((s, i) => {
          lines.push("```sql", String(asRecord(s).sql || ""), "```");
          if (i < sqls.length - 1) lines.push("");
        });
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(handleError(e));
      }
    },
  );

  server.registerTool(
    "yearning_audit_orders",
    {
      title: "待审工单列表",
      description:
        "分页列出与当前用户相关的待审核工单（审核人视角）。对应 WS /api/v2/audit/order/list",
      inputSchema: {
        page: z.number().int().min(1).default(1),
        page_size: z.number().int().min(1).max(100).default(10),
        status: z.number().int().optional().describe("状态过滤：2 待审核/3 已完成/0 已驳回"),
        text: z.string().optional().describe("按说明/工单号模糊搜索"),
        work_id: z.string().optional().describe("按工单号过滤"),
        response_format: ResponseFormat,
      },
      annotations: ro("待审工单列表"),
    },
    async ({ page, page_size, status, text, work_id, response_format }) => {
      try {
        const data = await client().auditOrders(page, page_size, {
          text,
          status,
          work_id,
        });
        if (response_format === "json") return ok(toJson(data));
        return ok(renderOrderList(`待审工单（第 ${page} 页）`, data));
      } catch (e) {
        return fail(handleError(e));
      }
    },
  );

  // ---------- 只读：查询与评论 ----------
  server.registerTool(
    "yearning_query_status",
    {
      title: "查询审核状态",
      description:
        "查看查询审核开关，以及当前用户查询工单是否有效。对应 GET /api/v2/fetch/is_query + /fetch/query_status",
      inputSchema: { response_format: ResponseFormat },
      annotations: ro("查询审核状态"),
    },
    async ({ response_format }) => {
      try {
        const data = await client().queryStatus();
        if (response_format === "json") return ok(toJson(data));
        const isQuery = asRecord(data.is_query_open);
        const expired = data.my_query_status;
        return ok(
          renderKv("查询审核状态", {
            查询审核开关: isQuery.status,
            是否允许导出: isQuery.export,
            我的查询工单状态: expired ? "无有效工单/已过期" : "有效",
          }),
        );
      } catch (e) {
        return fail(handleError(e));
      }
    },
  );

  server.registerTool(
    "yearning_run_query",
    {
      title: "执行查询",
      description:
        "在指定数据源执行只读 SELECT 查询。需具备查询权限；若开启查询审核，需先 yearning_submit_query_order。对应 WS /api/v2/query/results（msgpack）",
      inputSchema: {
        source_id: z.string().describe("数据源 ID"),
        schema: z.string().describe("库名"),
        sql: z.string().describe("查询 SQL（仅 SELECT）"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(100)
          .describe("返回行数上限（客户端截断）"),
        response_format: ResponseFormat,
      },
      annotations: ro("执行查询"),
    },
    async ({ source_id, schema, sql, limit, response_format }) => {
      try {
        const data = await client().runQuery(source_id, schema, sql);
        if (response_format === "json") return ok(toJson(data));
        const results = asArray(data.results);
        const lines = [`# 查询结果（耗时 ${data.query_time} ms）`, ""];
        if (!results.length) {
          lines.push("（无结果集）");
          return ok(lines.join("\n"));
        }
        results.forEach((rs, i) => {
          const set = asRecord(rs);
          const fields = asArray(set.field);
          const rows = asArray(set.data);
          const cols = fields.map((f) => String(asRecord(f).title ?? ""));
          const tableRows = rows.slice(0, limit).map((row) => {
            const r = asRecord(row);
            return Object.fromEntries(cols.map((c) => [c, r[c]]));
          });
          const truncated = rows.length > limit;
          const title = truncated
            ? `结果集 ${i + 1}（显示前 ${tableRows.length} 行 / 共 ${rows.length} 行）`
            : `结果集 ${i + 1}（共 ${rows.length} 行）`;
          if (i > 0) lines.push("");
          lines.push(
            renderList(
              title,
              tableRows,
              cols.map((c) => [c, c] as [string, string]),
              truncated ? `${tableRows.length}/${rows.length}` : rows.length,
            ),
          );
        });
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(handleError(e));
      }
    },
  );

  server.registerTool(
    "yearning_order_comments",
    {
      title: "工单评论",
      description: "读取指定工单的全部评论。对应 WS /api/v2/fetch/comment",
      inputSchema: {
        work_id: z.string().describe("工单号"),
        response_format: ResponseFormat,
      },
      annotations: ro("工单评论"),
    },
    async ({ work_id, response_format }) => {
      try {
        const data = await client().orderComments(work_id);
        if (response_format === "json") return ok(toJson(data));
        return ok(
          renderList(
            `工单 ${work_id} 评论`,
            data,
            [
              ["username", "评论人"],
              ["content", "内容"],
              ["time", "时间"],
            ],
            data.length,
          ),
        );
      } catch (e) {
        return fail(handleError(e));
      }
    },
  );

  // ---------- 写工具（只读模式下不注册） ----------
  if (!config.yearning.readOnly) {
    server.registerTool(
      "yearning_submit_order",
      {
        title: "提交 SQL 工单",
        description:
          "提交 SQL 工单（DDL/DML）。提交前建议先 yearning_sql_check。对应 POST /api/v2/common/post。" +
          "必须传 confirm=true 才会真正提交。",
        inputSchema: {
          source_id: z.string().describe("数据源 ID"),
          database: z.string().describe("目标库名"),
          sql: z.string().describe("完整 SQL 语句"),
          remark: z.string().describe("工单说明"),
          order_type: z.enum(["ddl", "dml"]).describe("工单类型"),
          confirm: z
            .literal(true)
            .describe("必须为 true，确认提交工单进入审核流程"),
          backup: z
            .number()
            .int()
            .min(0)
            .max(1)
            .default(0)
            .describe("是否备份：0 否 / 1 是（DML 建议开启）"),
          assigned: z
            .string()
            .optional()
            .describe("期望审核人（提示用；实际以流程模板为准）"),
          table: z.string().optional().describe("影响表名（可选）"),
          delay: z.string().optional().describe("延时执行时间，如 2026-01-01 02:00"),
          execute_time: z.string().optional().describe("执行时间（可选）"),
        },
        annotations: rw("提交 SQL 工单"),
      },
      async (args) => {
        try {
          const order: Record<string, unknown> = {
            source_id: args.source_id,
            data_base: args.database,
            sql: args.sql,
            text: args.remark,
            type: ORDER_TYPE_MAP[args.order_type],
            backup: args.backup,
          };
          if (args.assigned !== undefined) order.assigned = args.assigned;
          if (args.table !== undefined) order.table = args.table;
          if (args.delay !== undefined) order.delay = args.delay;
          if (args.execute_time !== undefined) order.execute_time = args.execute_time;
          const result = await client().submitOrder(order);
          return ok(`✅ 工单提交成功：${result}`);
        } catch (e) {
          return fail(handleError(e));
        }
      },
    );

    server.registerTool(
      "yearning_undo_order",
      {
        title: "撤回工单",
        description:
          "撤回自己提交、尚未执行的工单。对应 GET /api/v2/fetch/undo。必须传 confirm=true。",
        inputSchema: {
          work_id: z.string().describe("工单号"),
          confirm: z.literal(true).describe("必须为 true，确认撤回"),
        },
        annotations: rw("撤回工单", { idempotent: true }),
      },
      async ({ work_id }) => {
        try {
          const result = await client().undoOrder(work_id);
          return ok(`✅ 工单已撤回：${result}`);
        } catch (e) {
          return fail(handleError(e));
        }
      },
    );

    server.registerTool(
      "yearning_audit_order",
      {
        title: "审核工单",
        description:
          "审核工单：agree 同意（末级步骤会触发 SQL 执行）/ reject 驳回 / undo 撤回。" +
          "flag 为当前审核步骤序号（用 yearning_order_timeline 确认）；reject 必须提供 reason。" +
          "agree 为高危操作，必须 confirm=true。对应 POST /api/v2/audit/order/state",
        inputSchema: {
          work_id: z.string().describe("工单号"),
          action: z.enum(["agree", "reject", "undo"]).describe("审核动作"),
          flag: z.number().int().describe("当前审核步骤序号（来自 order_timeline）"),
          source_id: z.string().describe("数据源 ID"),
          confirm: z
            .literal(true)
            .describe("必须为 true，确认执行审核动作"),
          reason: z.string().optional().describe("驳回理由（action=reject 时必填）"),
          delay: z.string().optional().describe("延时执行时间（可选）"),
        },
        annotations: rw("审核工单", { destructive: true }),
      },
      async (args) => {
        try {
          if (args.action === "reject" && !args.reason) {
            return fail("错误：驳回操作必须提供 reason（驳回理由）");
          }
          const body: Record<string, unknown> = {
            work_id: args.work_id,
            tp: args.action,
            flag: args.flag,
            source_id: args.source_id,
          };
          if (args.reason !== undefined) body.text = args.reason;
          if (args.delay !== undefined) body.delay = args.delay;
          const result = await client().auditOrder(body);
          return ok(`✅ 审核完成：${result}`);
        } catch (e) {
          return fail(handleError(e));
        }
      },
    );

    server.registerTool(
      "yearning_submit_query_order",
      {
        title: "提交查询申请",
        description:
          "提交数据查询申请。开通查询审核时需审批通过后方可 yearning_run_query。对应 POST /api/v2/query/post",
        inputSchema: {
          source_id: z.string().describe("申请查询的数据源 ID"),
          remark: z.string().describe("查询申请理由"),
          export: z
            .number()
            .int()
            .min(0)
            .max(1)
            .default(0)
            .describe("是否允许导出：0 否 / 1 是"),
        },
        annotations: rw("提交查询申请"),
      },
      async ({ source_id, remark, export: exportFlag }) => {
        try {
          const result = await client().submitQueryOrder(source_id, remark, exportFlag);
          return ok(`✅ 查询申请已提交：${result}`);
        } catch (e) {
          return fail(handleError(e));
        }
      },
    );

    server.registerTool(
      "yearning_post_comment",
      {
        title: "发表工单评论",
        description: "在指定工单下发表评论。对应 POST /api/v2/fetch/comment",
        inputSchema: {
          work_id: z.string().describe("工单号"),
          comment: z.string().describe("评论内容"),
        },
        annotations: rw("发表工单评论"),
      },
      async ({ work_id, comment }) => {
        try {
          const result = await client().postComment(work_id, comment);
          return ok(`✅ 评论已发表：${result}`);
        } catch (e) {
          return fail(handleError(e));
        }
      },
    );
  }

  return server;
}
