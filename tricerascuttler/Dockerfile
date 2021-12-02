FROM denoland/deno:1.16.2
RUN mkdir /home/deno && chown deno /home/deno
COPY ./ /home/deno/application
WORKDIR /home/deno/application
RUN chown -R deno:deno /home/deno/application
USER deno
ENV DENO_DIR=/home/deno/.cache/deno
RUN deno cache --unstable main.ts
CMD deno run -A --unstable main.ts --logLevel ${LOG_LEVEL:-INFO}