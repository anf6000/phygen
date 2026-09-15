# ─────────────────────────────────────────────────────────────────────────────
# Capture image for the isolated worker.
#
# Build it from the repository root:
#   docker build -t phygen-capture:1 -f server/docker/Dockerfile .
#
# The image holds Chromium and playwright-core only. The version snapshot, the
# runtime, and the approved dependencies are mounted read-only at run time. The
# container gets no network, so nothing in it can reach a provider or a host.
#
# Debian Chromium renders WebGL with SwiftShader, which is the software backend
# this project must measure on a CPU server.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      ca-certificates \
      libnss3 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdrm2 \
      libgbm1 \
      libgtk-3-0 \
      libpangocairo-1.0-0 \
      libx11-xcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY server/docker/package.json /app/server/package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY server/src /app/server/src

ENV PHYGEN_CHROMIUM=/usr/bin/chromium
USER node
ENTRYPOINT ["node", "/app/server/src/capture/container-entry.mjs"]
