# syntax=docker/dockerfile:1

# ---- shared markdown parser ----------------------------------------------
# `vendor/lutez` is a git submodule (Zig 0.17.0). Both the server (static
# library) and the client (WASM) use it, so it is built once here and copied into
# the two later stages — neither of them needs Zig.
FROM debian:bookworm-slim AS lutez
ARG ZIG_VERSION=0.17.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl xz-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) zig_arch=x86_64 ;; \
      arm64) zig_arch=aarch64 ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-${zig_arch}-linux-${ZIG_VERSION}.tar.xz" \
      | tar -xJ -C /opt; \
    ln -s "/opt/zig-${zig_arch}-linux-${ZIG_VERSION}/zig" /usr/local/bin/zig
WORKDIR /lutez
COPY vendor/lutez ./
RUN zig build -Doptimize=ReleaseSafe --prefix zig-out \
    && zig build wasm --prefix zig-out

# ---- web client -----------------------------------------------------------
FROM node:24-bookworm-slim AS web
RUN corepack enable
WORKDIR /app/web
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
# The ReAgent checkout is a git submodule and a workspace package; its manifest
# must exist before the install so pnpm can link it.
COPY web/vendor/reagent/package.json ./vendor/reagent/package.json
RUN pnpm install --frozen-lockfile
COPY web/ ./
COPY builtin/plugins /app/builtin/plugins
# `pnpm run build` runs `scripts/build-lutez.mjs`, which is a no-op when the
# artifacts already exist and the submodule is absent.
COPY --from=lutez /lutez/zig-out/lib/lutez.wasm ./public/lutez.wasm
RUN pnpm run build

# ---- server ---------------------------------------------------------------
FROM rust:1.99-bookworm AS server
WORKDIR /app
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src
COPY builtin ./builtin
COPY --from=web /app/web/dist ./web/dist
# build.rs links this; without it the server does not build.
COPY --from=lutez /lutez/zig-out/lib/liblutez.a ./vendor/lutez/zig-out/lib/liblutez.a
RUN cargo build --release --locked

# ---- runtime --------------------------------------------------------------
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgcc-s1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home --home-dir /home/opal opal \
    && mkdir -p /data \
    && chown opal:opal /data

COPY --from=server /app/target/release/opalnote /usr/local/bin/opalnote

USER opal
WORKDIR /home/opal
# The container has no certificates by default; mount certs and unset this
# variable (or set OPALNOTE_NO_TLS=0) to serve HTTPS.
ENV OPALNOTE_DATA_DIR=/data \
    OPALNOTE_BIND=0.0.0.0:7827 \
    OPALNOTE_NO_TLS=true \
    RUST_LOG=opalnote=info,tower_http=warn

VOLUME ["/data"]
EXPOSE 7827
ENTRYPOINT ["opalnote", "serve"]
