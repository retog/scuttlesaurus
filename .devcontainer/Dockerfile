FROM denoland/deno:1.11.5
RUN apt update
RUN yes | apt install git
RUN mkdir /home/deno && chown deno /home/deno
USER deno
ENV SHELL="/bin/bash"
ENV DENO_DIR=/home/deno/.cache/deno