# Build-only baseline for premerge bundles; customer runtime remains VPS-native.
# Tool pins/checksums reuse scripts/ci/runner/Dockerfile, without runner caches.
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git xz-utils unzip python3 build-essential binutils \
    && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --retry 3 --connect-timeout 10 --max-time 120 \
      https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz -o /tmp/node.tar.xz \
    && echo 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6  /tmp/node.tar.xz' | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local \
    && rm /tmp/node.tar.xz && test "$(node --version)" = v24.21.0
RUN curl --fail --location --retry 3 --connect-timeout 10 --max-time 120 \
      https://registry.npmjs.org/pnpm/-/pnpm-10.33.4.tgz -o /tmp/pnpm.tgz \
    && echo '8e70ddc6649b18bc3d895cf3a908c0291ea4c38039ad8722c47e018daf1e9cfc  /tmp/pnpm.tgz' | sha256sum -c - \
    && mkdir /opt/pnpm && tar -xzf /tmp/pnpm.tgz --strip-components=1 -C /opt/pnpm \
    && ln -s /opt/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm \
    && rm /tmp/pnpm.tgz && test "$(pnpm --version)" = 10.33.4
RUN curl --fail --location --retry 3 --connect-timeout 10 --max-time 120 \
      https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-linux-x64.zip -o /tmp/bun.zip \
    && echo '3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18  /tmp/bun.zip' | sha256sum -c - \
    && unzip /tmp/bun.zip -d /tmp/bun \
    && install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
    && rm -rf /tmp/bun /tmp/bun.zip && test "$(bun --version)" = 1.4.3
RUN groupadd -g 10001 builder && useradd -u 10001 -g 10001 -m -s /bin/bash builder
USER 10001:10001
WORKDIR /work
ENTRYPOINT ["/bin/bash", "scripts/build-host-bundle.sh"]
