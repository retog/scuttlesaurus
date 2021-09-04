import ScuttlebuttHost from "./ScuttlebuttHost.ts";

/* starts an SSB peer configured according to command line options */

//parse params

//read base config from file, use defaults if missing

//adapt config according to params

const config = {
  rootDir: "~/.ssb/",
};

const host = new ScuttlebuttHost(config);
host.start();
