# 多阶段构建：编译 TypeScript 后以精简运行镜像发布
FROM node:22-alpine AS builder

WORKDIR /app

# Alpine / npm 国内镜像
RUN sed -i 's#https\?://dl-cdn.alpinelinux.org/alpine#https://mirrors.aliyun.com/alpine#g' /etc/apk/repositories \
  && npm config set registry https://registry.npmmirror.com

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev

# ---------- 运行阶段 ----------
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    MCP_TRANSPORT=streamable-http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8080 \
    MCP_LOG_LEVEL=info

# Alpine 阿里云源；wget 用于 HEALTHCHECK；非 root 运行
RUN sed -i 's#https\?://dl-cdn.alpinelinux.org/alpine#https://mirrors.aliyun.com/alpine#g' /etc/apk/repositories \
  && apk add --no-cache wget \
  && addgroup -S mcp \
  && adduser -S mcp -G mcp

COPY --from=builder --chown=mcp:mcp /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=mcp:mcp /app/node_modules ./node_modules
COPY --from=builder --chown=mcp:mcp /app/dist ./dist
COPY --chown=mcp:mcp README.md LICENSE .env.example ./

USER mcp

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "dist/index.js"]
