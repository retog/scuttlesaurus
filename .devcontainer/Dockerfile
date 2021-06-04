FROM denoland/deno:1.10.3
RUN apt update
RUN yes | apt install git
RUN mkdir /home/deno && chown deno /home/deno
USER deno
