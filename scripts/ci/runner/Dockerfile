# Dedicated x86-64 benchmark image. No GitHub runner listener is installed.
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git ripgrep xz-utils unzip python3 build-essential \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
    libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libdrm2 libxkbcommon0 libasound2t64 libcups2 libgtk-3-0 \
    libpango-1.0-0 libcairo2 libdbus-1-3 libsecret-1-0 fonts-liberation \
    xvfb xauth time procps && rm -rf /var/lib/apt/lists/*

RUN curl --fail --location --retry 3 --connect-timeout 10 --max-time 120 \
      https://nodejs.org/dist/v24.14.1/node-v24.14.1-linux-x64.tar.xz -o /tmp/node.tar.xz \
    && echo '84d38715d449447117d05c3e71acd78daa49d5b1bfa8aacf610303920c3322be  /tmp/node.tar.xz' | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local \
    && rm /tmp/node.tar.xz && test "$(node --version)" = v24.14.1
RUN curl --fail --location --retry 3 --connect-timeout 10 --max-time 120 \
      https://registry.npmjs.org/pnpm/-/pnpm-10.33.4.tgz -o /tmp/pnpm.tgz \
    && echo '8e70ddc6649b18bc3d895cf3a908c0291ea4c38039ad8722c47e018daf1e9cfc  /tmp/pnpm.tgz' | sha256sum -c - \
    && mkdir /opt/pnpm && tar -xzf /tmp/pnpm.tgz --strip-components=1 -C /opt/pnpm \
    && ln -s /opt/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm \
    && rm /tmp/pnpm.tgz && test "$(pnpm --version)" = 10.33.4
RUN curl --fail --location --retry 3 --connect-timeout 10 --max-time 120 \
      https://github.com/oven-sh/bun/releases/download/bun-v1.3.10/bun-linux-x64.zip -o /tmp/bun.zip \
    && echo 'f57bc0187e39623de716ba3a389fda5486b2d7be7131a980ba54dc7b733d2e08  /tmp/bun.zip' | sha256sum -c - \
    && unzip /tmp/bun.zip -d /tmp/bun \
    && install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
    && rm -rf /tmp/bun /tmp/bun.zip && test "$(bun --version)" = 1.3.10

RUN groupadd -g 10001 runner && useradd -u 10001 -g 10001 -m -s /bin/bash runner \
    && mkdir /work && chown 10001:10001 /work
COPY benchmark.sh /opt/matrix-ci/benchmark.sh
RUN chmod 0555 /opt/matrix-ci/benchmark.sh
ENV CI=true GIT_TERMINAL_PROMPT=0 PLAYWRIGHT_BROWSERS_PATH=/work/browsers
USER 10001:10001
WORKDIR /work
ENTRYPOINT ["/opt/matrix-ci/benchmark.sh"]
