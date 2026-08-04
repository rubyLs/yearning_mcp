/**
 * Yearning 客户端基类：JWT 生命周期、请求重放与信封解析。
 *
 * Yearning 使用账号密码登录换取 JWT（约 8 小时），客户端自动管理：
 * - 首次请求前登录并缓存 token
 * - 401 时重新登录并重放一次
 * - 距上次登录超过 7.5h 主动续登
 *
 * 注意：Yearning 部分 /fetch/* 接口使用 GET + JSON Body；
 * Node fetch/undici 禁止该写法，因此这里用 http/https 原生模块发请求。
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import type { AppConfig } from "../config.js";
import { YearningApiError, YearningAuthError } from "./errors.js";

const API_PREFIX = "/api/v2";
const TOKEN_TTL_MS = 7.5 * 3600 * 1000;

interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export class YearningClientBase {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly loginType: "general" | "ldap";
  readonly timeoutMs: number;
  private readonly insecure: boolean;

  protected token: string | null = null;
  protected loginAt = 0;
  private authLock: Promise<void> | null = null;

  constructor(config: AppConfig["yearning"]) {
    this.baseUrl = config.baseUrl;
    this.username = config.username;
    this.password = config.password;
    this.loginType = config.loginType;
    this.timeoutMs = config.timeoutMs;
    this.insecure = config.insecure;

    if (config.insecure) {
      console.error(
        "[yearning] TLS 证书验证已禁用（YEARNING_INSECURE=true），生产环境不建议使用",
      );
    }
  }

  getToken(): string | null {
    return this.token;
  }

  async ensureToken(): Promise<string> {
    if (this.token && Date.now() - this.loginAt < TOKEN_TTL_MS) {
      return this.token;
    }
    await this.withAuthLock(async () => {
      if (this.token && Date.now() - this.loginAt < TOKEN_TTL_MS) return;
      await this.login();
    });
    if (!this.token) throw new YearningAuthError("登录后仍无 token");
    return this.token;
  }

  private async reauth(): Promise<void> {
    await this.withAuthLock(async () => {
      this.token = null;
      await this.login();
    });
  }

  private async withAuthLock(fn: () => Promise<void>): Promise<void> {
    while (this.authLock) {
      await this.authLock;
    }
    let release!: () => void;
    this.authLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await fn();
    } finally {
      this.authLock = null;
      release();
    }
  }

  private async login(): Promise<void> {
    if (!this.username || !this.password) {
      throw new YearningAuthError(
        "缺少登录凭证，请设置环境变量 YEARNING_USERNAME 和 YEARNING_PASSWORD",
      );
    }
    const path = this.loginType === "ldap" ? "/ldap" : "/login";
    const resp = await this.rawRequest(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: this.username,
        password: this.password,
      }),
    });

    if (resp.status !== 200) {
      throw new YearningAuthError(
        `登录 Yearning 失败（HTTP ${resp.status}）：请检查 YEARNING_URL / 用户名 / 密码`,
      );
    }

    const payload = await this.unwrap(resp);
    const token =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).token
        : undefined;
    if (typeof token !== "string" || !token) {
      throw new YearningAuthError("登录响应缺少 token");
    }
    this.token = token;
    this.loginAt = Date.now();
    console.error(`[yearning] 登录成功：user=${this.username}`);
  }

  /** 统一认证请求入口；path 形如 '/fetch/source'（不含 /api/v2） */
  async request(
    method: string,
    path: string,
    options: {
      params?: Record<string, string | number | boolean | undefined | null>;
      jsonBody?: unknown;
      retried?: boolean;
    } = {},
  ): Promise<unknown> {
    await this.ensureToken();
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(options.params || {})) {
      if (v !== undefined && v !== null) query.set(k, String(v));
    }
    const qs = query.toString();
    const url = `${this.baseUrl}${API_PREFIX}${path}${qs ? `?${qs}` : ""}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    let body: string | undefined;
    if (options.jsonBody !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.jsonBody);
    }

    const resp = await this.rawRequest(url, { method, headers, body });

    if (resp.status === 401 && !options.retried) {
      await this.reauth();
      return this.request(method, path, { ...options, retried: true });
    }

    if (resp.status >= 400) {
      const text = await resp.text();
      throw new YearningApiError(`HTTP ${resp.status}: ${text}`, resp.status);
    }

    return this.unwrap(resp);
  }

  /** 原生 http(s) 请求，允许 GET 携带 body（Yearning 特殊约定） */
  private rawRequest(
    urlStr: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<HttpResponse> {
    const url = new URL(urlStr);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const method = (init.method || "GET").toUpperCase();
    const headers: Record<string, string> = { ...(init.headers || {}) };
    const body = init.body;

    if (body !== undefined) {
      headers["Content-Length"] = Buffer.byteLength(body).toString();
    }

    return new Promise((resolve, reject) => {
      const req = lib.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method,
          headers,
          timeout: this.timeoutMs,
          rejectUnauthorized: isHttps ? !this.insecure : undefined,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            const textBody = buf.toString("utf8");
            const hdrs: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === "string") hdrs[k.toLowerCase()] = v;
              else if (Array.isArray(v)) hdrs[k.toLowerCase()] = v.join(", ");
            }
            resolve({
              status: res.statusCode || 0,
              headers: hdrs,
              async text() {
                return textBody;
              },
              async json() {
                return JSON.parse(textBody) as unknown;
              },
            });
          });
        },
      );

      req.on("timeout", () => {
        req.destroy();
        reject(
          new YearningApiError(
            `请求超时（${this.timeoutMs}ms），请检查 YEARNING_URL 是否可达`,
            408,
          ),
        );
      });
      req.on("error", (err) => {
        reject(
          new YearningApiError(
            `连接 Yearning 失败：${err.message}，请检查 YEARNING_URL`,
          ),
        );
      });

      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  private async unwrap(resp: HttpResponse): Promise<unknown> {
    const ctype = resp.headers["content-type"] || "";
    if (ctype.includes("application/json")) {
      let data: unknown;
      try {
        data = await resp.json();
      } catch {
        const text = await resp.text();
        throw new YearningApiError(text || "无法解析 JSON 响应", -1);
      }
      if (data && typeof data === "object" && "code" in data) {
        const env = data as { payload?: unknown; code?: number; text?: string };
        const code = env.code ?? 5555;
        if (code !== 1200) {
          throw new YearningApiError(env.text || "未知错误", code);
        }
        if (env.payload === null || env.payload === undefined) {
          return env.text || "";
        }
        return env.payload;
      }
      return data;
    }

    const text = (await resp.text()).trim();
    throw new YearningApiError(text || "未知错误", 5555);
  }
}
