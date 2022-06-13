FROM denoland/deno:1.22.2
RUN mkdir /home/deno && chown deno /home/deno
COPY . /home/deno/application/
WORKDIR /home/deno/application/tricerascuttler
RUN chown -R deno:deno /home/deno/application
USER deno
ENV DENO_DIR=/home/deno/.cache/deno
RUN deno run --unstable -A ./build.ts
RUN deno cache --unstable main.ts
CMD deno run -A --unstable main.ts --web.control.hostname 0.0.0.0 --logLevel ${LOG_LEVEL:-INFO}