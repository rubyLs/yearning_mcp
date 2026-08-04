# @rubyls/yearning-mcp

Yearning SQL 审核平台的 MCP Server（TypeScript）。不只读查询，还覆盖完整工单能力：**提交 DDL/DML、审核（同意/驳回）、撤回、查询申请、评论**，以及数据源/表结构探查。

基于 Yearning REST / WebSocket API（`/api/v2`，JWT Bearer）。列表类与查询执行走 WebSocket，其余为 REST。

仓库：https://github.com/rubyLs/yearning_mcp

## 快速接入（推荐）

发布到 npm 后，在 Cursor / Claude Desktop 的 MCP 配置中：

```json
{
  "mcpServers": {
    "yearning": {
      "command": "npx",
      "args": ["-y", "@rubyls/yearning-mcp"],
      "env": {
        "YEARNING_URL": "http://your-yearning:8000",
        "YEARNING_USERNAME": "your-user",
        "YEARNING_PASSWORD": "your-password",
        "YEARNING_LOGIN_TYPE": "general",
        "YEARNING_READ_ONLY": "false"
      }
    }
  }
}
```

也可全局安装后使用：

```bash
npm i -g @rubyls/yearning-mcp
yearning-mcp
```

## Docker（单容器 HTTP）

镜像默认 **streamable-http**，监听 `8080`。

```bash
# 构建
docker build -t yearning-mcp:latest .
# 或 npm run docker:build

# 运行
docker run -d --name yearning-mcp -p 8080:8080 \
  -e MCP_AUTH_TOKEN=your-strong-token \
  -e YEARNING_URL=http://your-yearning:8000 \
  -e YEARNING_USERNAME=your-user \
  -e YEARNING_PASSWORD=your-password \
  -e YEARNING_READ_ONLY=false \
  yearning-mcp:latest
```

- 健康检查：`GET http://localhost:8080/health`
- MCP 端点：`http://localhost:8080/mcp`
- Header：`Authorization: Bearer <MCP_AUTH_TOKEN>`

Cursor 连接示例：

```json
{
  "mcpServers": {
    "yearning": {
      "url": "http://localhost:8080/mcp",
      "headers": {
        "Authorization": "Bearer your-strong-token"
      }
    }
  }
}
```

> 容器内访问宿主机 Yearning 时，macOS/Windows 可用 `host.docker.internal` 代替 `localhost`。

## 功能一览

### 只读工具（14）

| 工具 | 说明 |
|------|------|
| `yearning_user_info` | 当前用户与可查询数据源 |
| `yearning_list_sources` | 数据源列表 |
| `yearning_list_databases` | 库列表 |
| `yearning_list_tables` | 表列表 |
| `yearning_table_fields` | 表结构（字段 + 索引） |
| `yearning_sql_check` | 提交前 SQL 审核检测 |
| `yearning_my_orders` | 我的工单列表 |
| `yearning_order_detail` | 工单详情 |
| `yearning_order_timeline` | 审核时间线 / 步骤（含 `flag`） |
| `yearning_rollback_sql` | 回滚 SQL |
| `yearning_audit_orders` | 待我审核的工单 |
| `yearning_query_status` | 查询审核开关与我的查询工单状态 |
| `yearning_run_query` | 只读 SELECT（msgpack WebSocket） |
| `yearning_order_comments` | 读取工单评论 |

### 写工具（5，`YEARNING_READ_ONLY=false` 时注册）

| 工具 | 说明 |
|------|------|
| `yearning_submit_order` | 提交 SQL 工单（需 `confirm=true`；`backup=1` 开启回滚备份） |
| `yearning_undo_order` | 撤回未执行工单（需 `confirm=true`） |
| `yearning_audit_order` | 审核：agree / reject / undo（需 `confirm=true`） |
| `yearning_submit_query_order` | 提交查询申请 |
| `yearning_post_comment` | 发表工单评论 |

工单状态：`0` 已驳回 / `1` 执行中 / `2` 待审核 / `3` 已完成 / `4` 已终止 / `5` 待执行 / `6` 已撤回。

推荐流程：

```
yearning_sql_check → yearning_submit_order → yearning_order_timeline → yearning_audit_order
```

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `YEARNING_URL` | Yearning 地址 | `http://localhost:8000` |
| `YEARNING_USERNAME` | 登录用户名 | （必填） |
| `YEARNING_PASSWORD` | 登录密码 | （必填） |
| `YEARNING_LOGIN_TYPE` | `general` / `ldap` | `general` |
| `YEARNING_TIMEOUT` | 请求超时（秒） | `30` |
| `YEARNING_READ_ONLY` | `true` 时不注册写工具 | `false` |
| `YEARNING_INSECURE` | 跳过 TLS 校验 | `false` |
| `MCP_TRANSPORT` | `stdio` / `sse` / `streamable-http` | `stdio` |
| `MCP_HOST` / `MCP_PORT` | HTTP 监听 | `0.0.0.0` / `8080` |
| `MCP_AUTH_TOKEN` | HTTP Bearer 鉴权 | （不设则不鉴权） |
| `MCP_STATELESS_HTTP` | 无状态 HTTP | `false` |

## HTTP 远程模式

```bash
MCP_TRANSPORT=streamable-http \
MCP_HOST=0.0.0.0 MCP_PORT=8080 \
MCP_AUTH_TOKEN=your-strong-token \
YEARNING_URL=http://your-yearning:8000 \
YEARNING_USERNAME=your-user \
YEARNING_PASSWORD=your-password \
YEARNING_READ_ONLY=false \
npx -y @rubyls/yearning-mcp
```

客户端连接：`http://localhost:8080/mcp`，Header：`Authorization: Bearer your-strong-token`。  
健康检查：`GET /health`（免鉴权）。

## 从源码运行

```bash
git clone https://github.com/rubyLs/yearning_mcp.git
cd yearning_mcp
npm install
npm run build
npm start
```

Cursor 本地调试：

```json
{
  "mcpServers": {
    "yearning": {
      "command": "node",
      "args": ["/absolute/path/to/yearning_mcp/dist/index.js"],
      "env": {
        "YEARNING_URL": "http://localhost:8000",
        "YEARNING_USERNAME": "your-user",
        "YEARNING_PASSWORD": "your-password",
        "YEARNING_READ_ONLY": "false"
      }
    }
  }
}
```

## 对话示例

```
连上 Yearning，列出我有权限的数据源
```

```
把这条建表 SQL 在 dev 数据源做检测，没问题就提工单：
CREATE TABLE t_demo (id INT PRIMARY KEY, name VARCHAR(64));
```

```
列出待我审核的工单；工单 XXX 没问题，帮我同意（先看 timeline 拿 flag）
```

```
在 order_db 的 user 库查最近 7 天注册账号，前 100 条
```

## 开发

```bash
npm run dev          # tsx 直接跑 src
npm run build        # 编译到 dist/
npm start            # node dist/index.js
npm publish --access public   # 发布到 npm（需先 npm login）
```

## 已知限制

- 部分 `/fetch/*` 接口使用 **GET + JSON Body**；若前置代理丢弃 GET body，列表会静默为空。
- WebSocket 鉴权依赖 `Sec-WebSocket-Protocol` 透传裸 JWT，且需正确 `Origin`。
- 查询审核开启时，`yearning_run_query` 需先有已批准的查询工单。
- 管理端能力（用户/数据源/规则管理）未包含，请在 Yearning 控制台操作。

## License

MIT
