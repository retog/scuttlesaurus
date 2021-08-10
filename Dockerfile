FROM denoland/deno:1.12.2
RUN mkdir /home/deno && chown deno /home/deno
USER deno
ENV DENO_DIR=/home/deno/.cache/deno
COPY ./ /home/deno/application
WORKDIR /home/deno/application
CMD ["run", "-A", "--unstable", "run.ts"]