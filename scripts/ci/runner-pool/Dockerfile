# Ephemeral GitHub Actions runner for the dedicated CI host (specs/633-ci-runner-pool).
# Jobs install Node, pnpm and Bun through their setup actions, as on hosted runners. The image
# supplies only OS packages, so E2E never waits on the Ubuntu mirror inside a job.
FROM ghcr.io/actions/actions-runner:2.338.1@sha256:e275409999c37162649aa050ca573f03eab2eabcb3a1e7fcc47548de6b4f9690

USER root
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8

# Playwright 1.58 Chromium dependencies for Ubuntu 24.04 (`playwright install-deps --dry-run chromium`),
# plus Electron's GTK/secret-store libraries, the unit suite's ripgrep and the tools CI steps call.
# Package lists stay in the image so in-job `apt-get install` of an installed package is a no-op.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq ripgrep unzip xz-utils python3 build-essential time procps xauth \
      libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 \
      libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 \
      libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
      libgtk-3-0t64 libsecret-1-0 libfontconfig1 libfreetype6 xvfb \
      fonts-noto-color-emoji fonts-unifont xfonts-cyrillic xfonts-scalable fonts-liberation \
      fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf fonts-freefont-ttf \
    && rg --version && jq --version

# The host decides which source may run here; a workflow cannot remove or edit this hook. It
# kills the runner on rejection (needs procps), so no step can run after it.
# pnpm/action-setup bootstraps with `npm ci` before setup-node runs, so the image needs Node and
# npm, as hosted runners have. Ubuntu's Node 18 is too old for pnpm's installer, so pin a release
# matching the repository's engine; setup-node then puts the job's Node ahead of it on PATH.
ARG NODE_VERSION=24.22.2
ARG NODE_SHA256=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75
RUN curl -fsSL --max-time 300 -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
    && rm /tmp/node.tar.xz && node --version && npm --version

# Plain COPY and chmod: the CI host's Docker has no BuildKit, which `COPY --chmod` needs.
COPY --chown=root:root job-started.sh /opt/matrix-ci/job-started.sh
RUN chmod 0555 /opt/matrix-ci/job-started.sh
ENV ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/matrix-ci/job-started.sh

USER runner
WORKDIR /home/runner
