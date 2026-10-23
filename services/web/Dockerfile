# Build from the repository root:  docker build -f services/web/Dockerfile .
FROM rust:1-bookworm AS devtool
ARG DEVTOOL_REV=0b3436bb8d235c67cd36b800cb45a7b1b489c415
RUN cargo install --locked --git https://github.com/zcash/zcash-devtool --rev ${DEVTOOL_REV} zcash-devtool

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=devtool /usr/local/cargo/bin/zcash-devtool /usr/local/bin/zcash-devtool
WORKDIR /app
COPY packages/core packages/core
COPY services/web services/web
COPY scripts scripts
RUN cd packages/core && npm install --omit=dev --no-audit --no-fund \
 && cd /app/services/web && npm install --no-audit --no-fund && npm run build
ENV DATA_DIR=/data NODE_ENV=production
WORKDIR /app/services/web
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
