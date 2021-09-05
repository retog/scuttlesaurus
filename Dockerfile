FROM denoland/deno:1.13.2
RUN mkdir /home/deno && chown deno /home/deno
USER deno
ENV DENO_DIR=/home/deno/.cache/deno
COPY ./ /home/deno/application
WORKDIR /home/deno/application
RUN deno cache --unstable main.ts
CMD ["run", "-A", "--unstable", "main.ts"]