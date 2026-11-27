ARG NODE_BASE_IMAGE=node:26.13.1-bookworm-slim
ARG PYTHON_BASE_IMAGE=python:3.12-slim-bookworm
# The image installs the reviewed distribution from the registry instead of building it
# from a checkout. The variant package pins the runtime and every reviewed plugin, and
# carries the profile name and the omission overrides the profile needs, so the build
# needs neither a git ref nor a build toolchain. Raising either version reaches different
# plugin membership, so the assertions in the profile stage move with them.
# The distribution version. No default: the build script always passes it, and an empty value
# must stay empty so a missing argument is visible rather than silently replaced.
ARG DSH_PLUS_VERSION
ARG DSH_OMITTED_PACKAGE=@sparkelf/dsh-omitted
# A comma-separated `<name>@<version>` list raising one republished plugin past the version the
# standalone pins, for a fix that has to reach the image before the next standalone release. The
# standalone shares a single version across every plus member, so republishing it for one plugin
# moves the whole family; this names the version directly instead. Empty by default, and the
# assembly fails when a name here is not a package the profile declares.
ARG DATAOPS_PROFILE_VERSION_PINS=
# A comma-separated list of scoped patch-package names the build applies on top of the published
# set. The declaration is read from the installed `@sparkelf/dsh-plus`, whose `patchPackages` was
# fixed at publication, so a patch that has to reach the image before the distribution is
# republished cannot enter otherwise; republishing moves every plus member, because the family
# shares one version. Each name must be installed beside the distribution. Empty by default.
ARG DATAOPS_EXTRA_PATCH_VERSION=
ARG DATAOPS_EXTRA_PATCH_PACKAGES=
# The official runtime the profile must boot.
#
# The distribution republishes a slice of the official packages as `@sparkelf/*` and substitutes
# them by override, and those substitutions carry the version they were built from. The official
# packages check each other with exact peer pins, so the runtime has to be that same version.
# `compatibility.dsh` only declares a FLOOR, and a prerelease range admits the next prerelease:
# on 0.2.1-alpha.20 it resolved `>=0.2.1-alpha.1` to `0.2.1-alpha.2` while every republished
# package stopped at `0.2.1-alpha.1`. DSH then refused the profile -- sql-workbench and
# session-query skipped, the auto-review row disabled, and the required `connection`
# service failed with "cannot get property webRuntime without inject" -- so the workspace never
# became ready. Pinning here keeps the runtime and the substitution set together.
#
# At 0.2.1-alpha.26 the substitution set is uniform again: every override names 0.2.1-alpha.2,
# the runtime below. alpha.23 through alpha.25 carried five that named 0.2.1-alpha.1 --
# dsh-llm, dsh-host-webserver, dsh-subagent, dsh-host-frontend-static and
# dsh-api-terminal-controller -- because they are not workspaces a source patch edits, so the
# packager never republished them and the override pinned their last build beside a runtime one
# release ahead. Three were byte-identical to the official build at the same version and two
# differed only in a generated type descriptor, so the floor admitted them and no gate objected.
# The generator derives the version per package rather than assuming the runtime version, so this
# pin names the official runtime the overrides were derived against.
#
# This one value decides the whole official family, and raising it is not a local change: the
# standalone pins 51 of those names to the version it was built against, so a runtime ahead of that
# set leaves every one of them in two versions at once. Measured 2026-10-15, raising it to
# 0.2.1-alpha.3 produced 40 duplicate packages and DSH would not start.
ARG DSH_RUNTIME_VERSION=0.2.3-alpha.2
# 11.7.0 can leave install workers alive after completion; 11.23.0 fixes that hang.
ARG DSH_PNPM_VERSION=11.23.0
ARG DSH_NPM_FETCH_ATTEMPTS=5

# Seconds one profile-install attempt may run before the next one starts.
ARG DSH_PROFILE_INSTALL_TIMEOUT_S=420
# OfficeCLI's engine, fetched once into its own stage. The package's postinstall would otherwise
# download it from GitHub Releases, which this network cannot reach: the package's own mirror
# redirects there and the redirect target answers nothing, so that single step spent 33 of this
# image's 35 minutes retrying a timeout. An intranet build points OFFICECLI_ENGINE_URL at a mirror
# it can reach; the checksum is verified either way, so a mirror cannot substitute another binary.
ARG OFFICECLI_ENGINE_URL=https://gh-proxy.com/https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.147/officecli-linux-x64
ARG OFFICECLI_ENGINE_SHA256=e8bfe04f670139f526fe4e81f11acc1bc8629e421a20c5ba7a6e25f7a54a31f7

FROM ${NODE_BASE_IMAGE} AS node-runtime

FROM node-runtime AS dsh-build-base
ARG DSH_PNPM_VERSION
ARG NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ENV CI=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NPM_CONFIG_REGISTRY=${NPM_CONFIG_REGISTRY}
  # pnpm reads its registry from configuration files, not from the
  # NPM_CONFIG_REGISTRY environment variable, so the mirror declared above only
  # takes effect once it is written to .npmrc. Without this the build resolved
  # every package from registry.npmjs.org and spent minutes on connection timeouts.
  RUN printf 'registry=%s\n' "${NPM_CONFIG_REGISTRY}" > /root/.npmrc \
      && test "$(npm config get registry)" = "${NPM_CONFIG_REGISTRY}"
# The build base gets the same mirror as the runtime stage below. Debian's own host answers
# this network at 10-50 kB/s where the mirror answers at 1.7 MB/s, and this layer is the first
# thing a cold build waits on, so leaving it pointed at `deb.debian.org` costs most of an hour
# before any package is compiled.
# Over plain HTTP on purpose: this base image has no `ca-certificates` yet, so an HTTPS mirror
# fails the handshake with "the certificate issuer is unknown" before apt can install the very
# package that would validate it. Debian's apt treats plain HTTP sources as trusted, and the
# mirror is reached over the internal network.
RUN printf '%s\n' \
        "deb http://mirrors.huaweicloud.com/debian bookworm main" \
        "deb http://mirrors.huaweicloud.com/debian bookworm-updates main" \
        "deb http://mirrors.huaweicloud.com/debian-security bookworm-security main" \
        > /etc/apt/sources.list \
    && rm -f /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        g++ \
        make \
        python3 \
    && rm -rf /var/lib/apt/lists/*
# pnpm comes from npm rather than corepack. corepack resolves the package manager from its own
# hardcoded origin, so on a network that cannot reach registry.npmjs.org this layer fails before
# any of the mirror work begins; COREPACK_NPM_REGISTRY points it at the mirror, but corepack does
# not follow the mirror's redirect to its CDN and still fails. npm reads the registry written
# above and fetches through it, which is what makes this layer survive a cold build. The failure
# hides on a warm machine: a build whose layers are already cached never runs this step.
RUN git config --system http.lowSpeedLimit 1024 \
    && git config --system http.lowSpeedTime 120 \
    && npm install -g "pnpm@${DSH_PNPM_VERSION}" --registry "${NPM_CONFIG_REGISTRY}" \
    && pnpm --version

# Install the reviewed distribution from the registry.
#
# The root manifest carries the omission overrides because npm reads `overrides` only
# from the install root: the same substitution inside the variant's own manifest is
# ignored, and a capability that reaches the tree through `@sparkelf/dsh-plus` would
# otherwise arrive as the real package. The profile stage below restates them where pnpm
# reads them, which is what actually removes the capability from the profile's tree.
# The OfficeCLI engine, fetched and verified in a stage of its own so the profile install below
# never reaches for the network. `curl` follows the mirror's redirect; the checksum is the
# authority, so an unreachable or substituted download fails the build rather than shipping an
# image whose OfficeCLI cannot start.
FROM dsh-build-base AS officecli-engine
# The release publishes one native asset per platform, and the npm launcher resolves the file
# name from process.arch (`vendor/officecli-linux-<arch>`), so the asset name is part of the
# contract: an x64 binary in an arm64 image is never found, and nothing fails until a document
# conversion is attempted.
ARG TARGETARCH
ARG OFFICECLI_ENGINE_VERSION=1.0.147
ARG OFFICECLI_ENGINE_BASE_URL=https://gh-proxy.com/https://github.com/iOfficeAI/OfficeCLI/releases/download/v${OFFICECLI_ENGINE_VERSION}
ARG OFFICECLI_ENGINE_SHA256_amd64=e8bfe04f670139f526fe4e81f11acc1bc8629e421a20c5ba7a6e25f7a54a31f7
ARG OFFICECLI_ENGINE_SHA256_arm64=f90c734722fd2f41ae76e72878329f033ed36c132aa741ec44dc3827066c55b9
COPY officecli-bin/ /opt/officecli-bin/
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) asset=officecli-linux-x64; want="${OFFICECLI_ENGINE_SHA256_amd64}" ;; \
      arm64) asset=officecli-linux-arm64; want="${OFFICECLI_ENGINE_SHA256_arm64}" ;; \
      *) echo "officecli: unsupported architecture '$arch'" >&2; exit 1 ;; \
    esac; \
    if [ -f "/opt/officecli-bin/${asset}" ]; then \
        cp "/opt/officecli-bin/${asset}" /officecli; \
        echo "  officecli: context binary ${asset}"; \
    else \
        curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 600 \
            -o /officecli "${OFFICECLI_ENGINE_BASE_URL}/${asset}"; \
        echo "  officecli: downloaded ${asset}"; \
    fi; \
    test "$(sha256sum /officecli | cut -d' ' -f1)" = "$want"; \
    chmod 0755 /officecli; \
    printf '%s\n' "$asset" > /officecli-asset; \
    echo "  officecli ${asset} $(stat -c %s /officecli) bytes, checksum verified"

# Playwright 1.57.0 downloads its browser archive but never finishes extracting it under Node 26:
# the download reaches 100%, then no file is written and the step hangs. The browser is a static
# tree, so it is installed here under Node 24 and only the cache is copied into the Node 26 base.
# Keep PLAYWRIGHT_VERSION and PLAYWRIGHT_DOWNLOAD_HOST in step with the base-stage defaults below;
# the browser revision is compiled into the package, so a version skew changes what gets copied.
FROM node:24.22.3-bookworm-slim AS playwright-browsers
ARG PLAYWRIGHT_VERSION=1.57.0
ARG PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
RUN set -eux; \
    npm install -g --no-audit --no-fund "playwright@${PLAYWRIGHT_VERSION}"; \
    playwright --version; \
    PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST}" playwright install chromium; \
    chromium_bin="$(find "${PLAYWRIGHT_BROWSERS_PATH}" -type f -path '*/chromium-*/chrome-linux*/chrome' | head -1)"; \
    test -x "${chromium_bin}"

FROM ${PYTHON_BASE_IMAGE} AS workspace-base
# The officecli engine and the asset name it was built from travel with the base so the runtime
# layer can install the binary under the name the npm launcher resolves for this architecture.
COPY --from=officecli-engine /officecli /usr/local/lib/dataops/officecli-engine
COPY --from=officecli-engine /officecli-asset /usr/local/lib/dataops/officecli-asset
# OfficeCLI has no global style-pack/default-template switch, so the default GB/T 9704-2012
# layout ships as blank DOCX templates plus the officecli-create wrapper. The DSH officecli
# plugin resolves the same directory through OFFICECLI_STYLE_PACKS_DIR (default below).
COPY officecli/ /opt/officecli/
RUN chmod 0755 /opt/officecli/bin/officecli-create \
    && ln -sf /opt/officecli/bin/officecli-create /usr/local/bin/officecli-create \
    && ln -sf /usr/local/lib/dataops/officecli-engine /usr/local/bin/officecli \
    && test -f /opt/officecli/style-packs/gbt9704-2012/template.docx \
    && test -f /opt/officecli/style-packs/red-header/template.docx

ARG PIP_INDEX_URL=https://mirrors.huaweicloud.com/repository/pypi/simple
ARG PIP_TRUSTED_HOST=mirrors.huaweicloud.com
ARG PIP_DEFAULT_TIMEOUT=120
ARG PIP_RETRIES=5
ARG PIP_INSTALL_ATTEMPTS=5
ARG NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ARG NPM_VERSION=12.0.2
ARG DEBIAN_MIRROR_URL=https://mirrors.huaweicloud.com/debian
ARG DEBIAN_SECURITY_MIRROR_URL=https://mirrors.huaweicloud.com/debian-security
# The omission assertion below names the placeholder, so the version the installer pinned
# is restated here: an ARG declared in an earlier stage is not visible in this one.
ARG DSH_PLUS_VERSION
ARG DSH_OMITTED_PACKAGE
ARG TARGETARCH

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST} \
    PIP_DEFAULT_TIMEOUT=${PIP_DEFAULT_TIMEOUT} \
    PIP_RETRIES=${PIP_RETRIES} \
    PIP_INSTALL_ATTEMPTS=${PIP_INSTALL_ATTEMPTS} \
    PYTHONUNBUFFERED=1 \
    NPM_CONFIG_REGISTRY=${NPM_CONFIG_REGISTRY} \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    WORKSPACE_ROOT=/workspace \
    DATAOPS_DSH_ROOT=/opt/dsh-plus \
    DATAOPS_DSH_HOME=/workspace/.dataops/dsh \
    DATAOPS_DSH_HOST=127.0.0.1 \
    DATAOPS_DSH_PORT=3080 \
    DATAOPS_DSH_PROFILE=dataops-web \
    DATAOPS_DSH_PROFILE_TEMPLATE=/opt/dataops-dsh-profile-template

COPY --from=node-runtime /usr/local/ /usr/local/

# Host operations: the image shipped Python SSH libraries but no ssh(1), so an agent could not
# run the ordinary command-line tooling it reaches for. `openssh-client` covers ssh, scp, and
# ssh-keygen. These belong in this stage rather than the build stage: the final image starts from
# the Python base, so an install there is discarded.
# libatomic1 is not in the python:slim base, and the Node 26 binary copied from node-runtime links
# against it: without it every node invocation fails with "libatomic.so.1: cannot open shared
# object file".
# TDF LibreOffice is installed through apt from its own .deb packages. This keeps 25.8.7
# and lets apt resolve the system-library closure without installing Debian LibreOffice 7.4.
# The explicit library list covers TDF packages that do not declare every dlopen dependency.
# A DOCX->PDF smoke below proves the runtime before the base image is accepted.
RUN set -eux; \
    printf '%s\n' \
        "deb ${DEBIAN_MIRROR_URL} bookworm main" \
        "deb ${DEBIAN_MIRROR_URL} bookworm-updates main" \
        "deb ${DEBIAN_SECURITY_MIRROR_URL} bookworm-security main" \
        > /etc/apt/sources.list \
    && rm -f /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        fontconfig \
        fonts-liberation \
        fonts-noto-cjk \
        git \
        iproute2 \
        jq \
        libatomic1 \
        patch \
        procps \
        util-linux \
        ripgrep \
        tmux \
        openssh-client \
        rsync \
        zip \
        unzip \
        xz-utils \
        bzip2 \
        less \
        iputils-ping \
        dnsutils \
        netcat-openbsd \
        lsof \
        net-tools \
        yq \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

# DOCX/PPTX preview uses the TDF build, not Debian's 7.4: the newer OOXML import path is
# materially faster on complex documents. This belongs to the base layer so every plus
# rebuild reuses it instead of downloading and unpacking the 203MB tarball again.
ARG LIBREOFFICE_VERSION=25.8.7
ARG LIBREOFFICE_SERIES=25.8
ARG LIBREOFFICE_MIRROR=https://mirrors.aliyun.com/libreoffice
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) lo_arch=x86_64; lo_file_arch=x86-64; lo_sha=7f4d7b2e36921eec5122c655249a24cc88935ee357e8261fd3bccd15aa1f7b9f ;; \
      arm64) lo_arch=aarch64; lo_file_arch=aarch64; lo_sha= ;; \
      *) echo "unsupported LibreOffice architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    tarball="/tmp/libreoffice-${LIBREOFFICE_VERSION}.tar.gz"; \
    url="${LIBREOFFICE_MIRROR}/stable/${LIBREOFFICE_VERSION}/deb/${lo_arch}/LibreOffice_${LIBREOFFICE_VERSION}_Linux_${lo_file_arch}_deb.tar.gz"; \
    curl -fL --retry 3 --retry-delay 2 --max-time 600 "$url" -o "$tarball" || \
      curl -fL --retry 3 --retry-delay 2 --max-time 600 "https://download.documentfoundation.org/libreoffice/stable/${LIBREOFFICE_VERSION}/deb/${lo_arch}/LibreOffice_${LIBREOFFICE_VERSION}_Linux_${lo_file_arch}_deb.tar.gz" -o "$tarball"; \
    if [ -n "$lo_sha" ]; then echo "$lo_sha  $tarball" | sha256sum -c -; fi; \
    mkdir -p /tmp/libreoffice-debs; \
    tar xzf "$tarball" -C /tmp/libreoffice-debs; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      /tmp/libreoffice-debs/LibreOffice_*/DEBS/*.deb \
      libxinerama1 libnss3 libdbus-1-3 libcairo2 libglib2.0-0 libcups2 \
      libsm6 libice6 libx11-xcb1 libxfixes3 libxi6 libxtst6 libxdamage1 \
      libxcomposite1 libxrandr2 libxkbcommon0 libgbm1 libdrm2 \
      libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b libicu72 \
      libxml2 libxslt1.1 libcurl4 libssl3 libsqlite3-0 libmariadb3 \
      libpq5 libldap-2.5-0 libsasl2-2 libgssapi-krb5-2 libkrb5-3 \
      libxmlsec1 libyaml-0-2 libzstd1 libjpeg62-turbo libtiff6 libwebp7 liblcms2-2; \
    ln -sf /opt/libreoffice${LIBREOFFICE_SERIES}/program/soffice /usr/bin/soffice; \
    soffice --headless --version; \
    smoke_dir=/tmp/libreoffice-smoke; \
    rm -rf "$smoke_dir"; mkdir -p "$smoke_dir"; \
    cp /opt/officecli/style-packs/gbt9704-2012/template.docx "$smoke_dir/template.docx"; \
    soffice --headless --convert-to pdf --outdir "$smoke_dir" "$smoke_dir/template.docx" >/dev/null; \
    test -s "$smoke_dir/template.pdf"; \
    rm -rf "$smoke_dir" /tmp/libreoffice-debs "$tarball" /var/lib/apt/lists/*

ARG NPM_INSTALL_ATTEMPTS=5
ARG TSX_VERSION=4.23.1
# Stage npm before replacement so the running CLI never overwrites its own dependency tree.
RUN --mount=type=cache,id=dataops-workspace-npm,target=/root/.npm,sharing=locked \
    set -eux; \
    attempt=1; \
    npm_stage="$(mktemp -d)"; \
    until npm install --prefix "${npm_stage}" \
        --ignore-scripts \
        --no-audit \
        --no-fund \
        --fetch-retries=5 \
        --fetch-retry-factor=2 \
        --fetch-retry-mintimeout=2000 \
        --fetch-retry-maxtimeout=30000 \
        --fetch-timeout=120000 \
        "npm@${NPM_VERSION}"; \
    do \
        if [ "$attempt" -ge "$NPM_INSTALL_ATTEMPTS" ]; then \
            exit 1; \
        fi; \
        attempt=$((attempt + 1)); \
        sleep 2; \
    done; \
    node "${npm_stage}/node_modules/npm/bin/npm-cli.js" --version; \
    rm -rf /usr/local/lib/node_modules/npm; \
    mv "${npm_stage}/node_modules/npm" /usr/local/lib/node_modules/npm; \
    rm -rf "${npm_stage}"; \
    npm --version; \
    attempt=1; \
    until npm install -g \
        --fetch-retries=5 \
        --fetch-retry-factor=2 \
        --fetch-retry-mintimeout=2000 \
        --fetch-retry-maxtimeout=30000 \
        --fetch-timeout=120000 \
        "tsx@${TSX_VERSION}"; \
    do \
        if [ "$attempt" -ge "$NPM_INSTALL_ATTEMPTS" ]; then \
            exit 1; \
        fi; \
        attempt=$((attempt + 1)); \
        sleep 2; \
    done

# Playwright drives Chromium from inside the workspace: RPA jobs open pages in the same container
# the agent runs in, so the browser belongs to the base layer every runtime image descends from,
# not to one descendant. The CLI is pinned because `playwright install` downloads by the browser
# revision compiled into it -- Playwright 1.57.0 resolves chromium revision 1200, and raising the
# package moves the download to a different build directory.
#
# The download host is a parameter for the same reason the apt and pip mirrors are: Playwright's
# CDN is a redirector (measured 2026-11-01, it answers 307 towards storage.googleapis.com), so a
# host that cannot follow that redirect needs a mirror of its own. The npmmirror binary mirror
# serves the pinned revision-1200 archive directly and is the default here; Playwright unpacks and
# validates the archive either way, so a mirror cannot substitute a different browser.
ARG PLAYWRIGHT_VERSION=1.57.0
ARG PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright
# A cross-architecture build (buildx/QEMU) cannot launch Chromium: the renderer/GPU process
# aborts under emulation even though the arm64 binary and its libraries are correct. The browser
# is still installed and its binary version is executed; only the launch smoke is skipped, and
# the native box build keeps it enabled (the default).
ARG PLAYWRIGHT_SMOKE_CHECK=1
# The browser tree sits outside the profile trees and outside every mounted volume, so both a
# runtime image and a `docker commit` of a running workspace keep it. The path is stated instead
# of inherited from $HOME so a process started with a different HOME still finds the install.
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
# `install-deps` installs the Debian libraries Chromium needs; it runs its own apt-get update
# because the package list above was already cleaned, so the lists are cleaned again afterwards.
# The browser tree itself comes from the Node 24 stage: the CLI below must run under this image's
# Node 26, but its extraction does not. npm runs with --ignore-scripts so the package's install
# hook cannot fetch a browser without the pinned revision.
COPY --from=playwright-browsers /root/.cache/ms-playwright /root/.cache/ms-playwright
RUN --mount=type=cache,id=dataops-workspace-npm,target=/root/.npm,sharing=locked \
    set -eux; \
    attempt=1; \
    until npm install -g \
        --ignore-scripts \
        --no-audit \
        --no-fund \
        --fetch-retries=5 \
        --fetch-retry-factor=2 \
        --fetch-retry-mintimeout=2000 \
        --fetch-retry-maxtimeout=30000 \
        --fetch-timeout=120000 \
        "playwright@${PLAYWRIGHT_VERSION}"; \
    do \
        if [ "$attempt" -ge "$NPM_INSTALL_ATTEMPTS" ]; then \
            exit 1; \
        fi; \
        attempt=$((attempt + 1)); \
        sleep 2; \
    done; \
    playwright --version; \
    PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST}" \
        playwright install-deps chromium; \
    rm -rf /var/lib/apt/lists/*; \
    chromium_bin="$(find "${PLAYWRIGHT_BROWSERS_PATH}" -type f -path '*/chromium-*/chrome-linux*/chrome' | head -1)"; \
    test -x "${chromium_bin}"; \
    "${chromium_bin}" --version; \
    if [ "${PLAYWRIGHT_SMOKE_CHECK}" = "1" ]; then \
        NODE_PATH=/usr/local/lib/node_modules node -e "const { chromium } = require('playwright'); (async () => { const browser = await chromium.launch({ args: ['--no-sandbox'] }); const page = await browser.newPage(); await page.setContent('<h1>playwright-ready</h1>'); const heading = await page.textContent('h1'); await browser.close(); if (heading !== 'playwright-ready') throw new Error('headless smoke test returned ' + heading); console.log('playwright headless smoke test ok'); })().catch((error) => { console.error(error); process.exit(1); });"; \
    else \
        echo "playwright launch smoke skipped (cross-build)"; \
    fi; \
    ls -1 "${PLAYWRIGHT_BROWSERS_PATH}"; \
    du -sh "${PLAYWRIGHT_BROWSERS_PATH}"


# The lineage runtime's Doris and Postgres clients offer `frame="polars"` beside the default
# `frame="pandas"`; the polars branch imports it at call time.
# The automation scripts under backend/src/automation/builtin-scripts execute in this container,
# and their imports are not optional: a missing one fails at job time instead of at build time.
# They read the lineage stores and may ask for a `polars` frame, so pyarrow and sqlglot are here.
#
# `prefect` is not installed here: it is the lineage runtime the dispatched scripts import, and
# it runs in the Prefect worker image, which carries its own Dockerfile and requirements.
RUN --mount=type=cache,id=dataops-workspace-pip,target=/root/.cache/pip,sharing=locked \
    for package in \
        requests \
        httpx \
        cryptography \
        duckdb \
        pandas \
        openpyxl \
        PyYAML \
        reportlab \
        python-docx \
        docxtpl \
        python-pptx \
        pypdf \
        beautifulsoup4 \
        lxml \
        'psycopg[binary]' \
        PyMySQL \
        oracledb \
        paramiko \
        sshtunnel \
        scp \
        sqlalchemy \
        redis \
        pymongo \
        sqlparse \
        confluent-kafka \
        adbc-driver-flightsql \
        adbc-driver-manager \
        'pyarrow>=15,<23' \
        'sqlglot>=26,<30' \
        polars \
        fonttools; \
    do \
        attempt=1; \
        until pip3 install --prefer-binary "$package"; do \
            if [ "$attempt" -ge "$PIP_INSTALL_ATTEMPTS" ]; then \
                exit 1; \
            fi; \
            attempt=$((attempt + 1)); \
            sleep 2; \
        done; \
    done

ARG DSH_PLUS_VERSION

# One source identifies the installation: the distribution version. The profile marker
# carries the same value, so the runtime guard compares like with like.
ENV DATAOPS_DSH_SOURCE_REF=${DSH_PLUS_VERSION} \
    DATAOPS_DSH_PROFILE_SOURCE_REF=${DSH_PLUS_VERSION}

# Keep the built monorepo closure intact for the first embedded-Web cut. DSH
# profiles resolve installation-owned workspace packages through symlinks into
# this tree, so pruning it piecemeal would break the profile module fallback.
# Build toolchain for the DSH source materialization stage. Kept in the base
# layer so the source stage never installs packages and its cache stays stable
# across Plus/apply changes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake \
 && ln -sf /usr/bin/gcc /usr/local/bin/cc \
 && ln -sf /usr/bin/g++ /usr/local/bin/c++ \
 && ln -sf /usr/bin/gcc /usr/bin/cc \
 && ln -sf /usr/bin/g++ /usr/bin/c++ \
 && rm -rf /var/lib/apt/lists/*

# Playwright installs globally into /usr/local/lib/node_modules, which Node does not search for a
# bare `require()` from an arbitrary working directory. Every RPA script in this workspace is
# `node -e`/`node script.js` started from /workspace, so without this the CLI works and
# `require('playwright')` does not. NODE_PATH is consulted only after the local `node_modules`
# chain, and ESM `import` ignores it entirely, so no profile package is shadowed by it. The
# variable is set here, at the end of the stage, rather than beside the install above: an ENV
# changes the cache key of every RUN after it, and this one has nothing after it to invalidate.
ENV NODE_PATH=/usr/local/lib/node_modules
