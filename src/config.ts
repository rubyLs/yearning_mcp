/** 从环境变量加载运行配置 */

export type TransportKind = "stdio" | "sse" | "streamable-http";
export type LoginType = "general" | "ldap";

function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function envFloat(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaultValue;
}

function normalizeTransport(raw?: string): TransportKind {
  const value = (raw || "stdio").trim().toLowerCase().replace(/_/g, "-");
  if (value === "stdio") return "stdio";
  if (value === "sse") return "sse";
  if (value === "streamable-http" || value === "streamablehttp" || value === "http") {
    return "streamable-http";
  }
  throw new Error(
    `不支持的 MCP_TRANSPORT: ${raw}，仅支持 stdio、sse、streamable-http`,
  );
}

export interface AppConfig {
  yearning: {
    baseUrl: string;
    username: string;
    password: string;
    loginType: LoginType;
    timeoutMs: number;
    insecure: boolean;
    readOnly: boolean;
  };
  mcp: {
    transport: TransportKind;
    host: string;
    port: number;
    authToken?: string;
    statelessHttp: boolean;
    logLevel: string;
  };
}

export function loadConfig(): AppConfig {
  const loginType = (process.env.YEARNING_LOGIN_TYPE || "general").toLowerCase();
  if (loginType !== "general" && loginType !== "ldap") {
    throw new Error(
      `不支持的 YEARNING_LOGIN_TYPE: '${loginType}'，仅支持 general / ldap`,
    );
  }

  return {
    yearning: {
      baseUrl: (process.env.YEARNING_URL || "http://localhost:8000").replace(
        /\/+$/,
        "",
      ),
      username: process.env.YEARNING_USERNAME || "",
      password: process.env.YEARNING_PASSWORD || "",
      loginType,
      timeoutMs: envFloat("YEARNING_TIMEOUT", 30) * 1000,
      insecure: envBool("YEARNING_INSECURE", false),
      // 默认开放写工具；生产可设 YEARNING_READ_ONLY=true
      readOnly: envBool("YEARNING_READ_ONLY", false),
    },
    mcp: {
      transport: normalizeTransport(process.env.MCP_TRANSPORT),
      host: process.env.MCP_HOST || "0.0.0.0",
      port: Number(process.env.MCP_PORT || "8080") || 8080,
      authToken: process.env.MCP_AUTH_TOKEN || undefined,
      statelessHttp: envBool("MCP_STATELESS_HTTP", false),
      logLevel: (process.env.MCP_LOG_LEVEL || "info").toLowerCase(),
    },
  };
}
