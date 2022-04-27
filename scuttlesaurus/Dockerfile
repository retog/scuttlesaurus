FROM denoland/deno:1.21.0
RUN mkdir /home/deno && chown deno /home/deno
USER deno
ENV DENO_DIR=/home/deno/.cache/deno
COPY ./ /home/deno/application
WORKDIR /home/deno/application
RUN deno cache --unstable main.ts
CMD deno run --v8-flags=--max-old-space-size=4096 -A --unstable main.ts --web.control.hostname 0.0.0.0 --logLevel ${LOG_LEVEL:-INFO}