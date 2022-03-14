FROM denoland/deno:1.19.3
RUN mkdir /home/deno && chown deno /home/deno
USER deno
ENV DENO_DIR=/home/deno/.cache/deno
COPY ./ /home/deno/application
WORKDIR /home/deno/application
RUN deno cache --unstable main.ts
CMD deno run -A --unstable main.ts --web.control.hostname 0.0.0.0 --logLevel ${LOG_LEVEL:-INFO}