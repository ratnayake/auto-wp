# syntax=docker/dockerfile:1
# auto-wp MCP server image. Runs the TypeScript source through tsx (no build step), as non-root.
# Build: docker build -t auto-wp-mcp .   (pass --build-arg PLAYWRIGHT=0 for a smaller, HTTP-only image)
FROM node:24-bookworm-slim

ARG PLAYWRIGHT=1
# Keep in step with packageManager in package.json and playwright in pnpm-lock.yaml.
ARG PNPM_VERSION=11.20.0
ARG PLAYWRIGHT_VERSION=1.64.1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    AUTOWP_CONFIG=/config/config.yaml \
    COREPACK_ENABLE_STRICT=0

# Tooling and the browser first, so source changes do not repeat these downloads.
RUN npm install -g --no-fund --no-audit "pnpm@${PNPM_VERSION}" \
    && if [ "$PLAYWRIGHT" = "1" ]; then \
         npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium; \
       else \
         touch /etc/autowp-no-playwright; \
       fi \
    && rm -rf /root/.npm /root/.cache /tmp/* /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN --mount=type=cache,id=auto-wp-pnpm,target=/pnpm-store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm-store --package-import-method copy \
    && rm -rf /root/.cache /tmp/* \
    && install -d -o node -g node -m 0700 /data \
    && chmod 0755 /app/deploy/docker/entrypoint.sh

USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/app/deploy/docker/entrypoint.sh"]
CMD ["--http", "--host", "0.0.0.0", "--allow-remote"]
