# syntax=docker/dockerfile:1

# ---- web client -----------------------------------------------------------
FROM node:24-bookworm-slim AS web
RUN corepack enable
WORKDIR /app/web
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm run build

# ---- server ---------------------------------------------------------------
FROM rust:1.99-bookworm AS server
WORKDIR /app
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src
COPY plugins ./plugins
COPY --from=web /app/web/dist ./web/dist
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
ENTRYPOINT ["opalnote"]
