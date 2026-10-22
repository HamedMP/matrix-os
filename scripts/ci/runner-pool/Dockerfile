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

USER runner
WORKDIR /home/runner
