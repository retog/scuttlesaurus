# Compsoscuttly

A Scuttlebutt client and feed viewer running entirely in the browser. It can connect to pubs
via websockets and display the contents of feeds.

The project mascot is a [Compsognathus longipes](https://synospecies.plazi.org/#Compsognathus+longipes)
![](https://upload.wikimedia.org/wikipedia/commons/c/c4/Compsognathus_BW.jpg)

## Usage

To create a library to use in the browser run

    deno run --inspect --unstable -A build.ts

Subsequently you can serve the files in the web directory, such as with:

    deno run --allow-net --allow-read https://deno.land/std@0.106.0/http/file_server.ts -p 8080

and access http://localhost:8080/ .
