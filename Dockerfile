# A Scuttlesaurus node. Build and run with `docker compose up -d`; see
# docs/INSTALL.md. The base image's entrypoint runs `deno` for known
# subcommands such as `run`, so CMD below is passed to deno.
FROM denoland/deno:2.9.6

ENV DATA_DIR=/data \
    HOSTNAME=0.0.0.0 \
    PORT=7777 \
    DENO_DIR=/deno-dir

WORKDIR /app

# The directories the node writes to. They are created before USER, so that
# the deno user owns them. /data/graph is the graph directory of the qlever-dir
# store, which docker-compose.qlever.yml mounts as a named volume. A new named
# volume takes the ownership of the image's directory at its mount point, so
# the directory must exist here, owned by deno, or the node could not write it.
RUN mkdir -p /app /data /data/graph /deno-dir && chown -R deno:deno /app /data /deno-dir

USER deno

# Dependencies first. Their manifests change less often than the source, so
# this layer stays cached while the code changes.
COPY --chown=deno:deno deno.json deno.lock ./
COPY --chown=deno:deno web/deno.json ./web/
RUN deno install

COPY --chown=deno:deno . .

# Build the web client and cache the server's modules, so that the first start
# downloads nothing.
RUN deno task build && deno cache main.ts

VOLUME ["/data"]
EXPOSE 7777

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["deno", "eval", "fetch(`http://127.0.0.1:${Deno.env.get('PORT') ?? 7777}/api/status`).then((r) => Deno.exit(r.ok ? 0 : 1), () => Deno.exit(1))"]

CMD ["run", "-A", "main.ts"]
