FROM docker.io/library/node:24.18.0-bookworm-slim@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6
LABEL org.opencontainers.image.source=https://github.com/milind-soni/OpenMausBot \
      org.opencontainers.image.revision=5491874882378603aef2536790650a192e63d56d
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl fonts-liberation git libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 \
    libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxkbcommon0 libxrandr2 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/openmausbot
COPY package.json pnpm-lock.yaml ./
RUN corepack pnpm@10.33.4 install --prod --ignore-scripts --frozen-lockfile --config.enableGlobalVirtualStore=false
COPY dist ./dist
COPY dist-server ./dist-server
COPY skills ./skills
COPY LICENSE NOTICE ./
COPY third_party ./third_party
COPY browser-engine ./browser-engine
ENV HOME=/data NODE_ENV=production OMB_RESOURCES_PATH=/opt/openmausbot \
    AGENT_BROWSER_EXECUTABLE_PATH=/opt/openmausbot/browser-engine/chrome/chrome-headless-shell-linux64/chrome-headless-shell
USER 65532:65532
RUN ./browser-engine/agent-browser --version && "$AGENT_BROWSER_EXECUTABLE_PATH" --version
ENTRYPOINT ["/bin/sh", "-c", "umask 007; exec node dist-server/index.js"]
