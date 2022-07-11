import DenoScuttlebuttHost from "./DenoScuttlebuttHost.ts";
import { exists, path } from "./util.ts";
import { Args, parse } from "https://deno.land/std@0.112.0/flags/mod.ts";

/* return an SSB peer configured according to command line options */
export async function createScuttlebuttHost() {
  return new DenoScuttlebuttHost(await createScuttlebuttConfig());
}

export async function createScuttlebuttConfig() {
  const options = parse(Deno.args, {
    /*boolean: "incoming"*/
  });
  //read base config from file, use defaults if missing
  const config = await getBaseConfig(options);

  //adapt config according to params
  if (typeof (options.incoming) !== "undefined") {
    config.acceptIncomingConnections =
      options.incoming.toLowerCase() === "true";
  }
  if (typeof (options.outgoing) !== "undefined") {
    config.outgoingConnections = options.outgoing.toLowerCase() === "true";
  }
  if (typeof (options.web) !== "undefined") {
    for (const endpoint in options.web) {
      config.web[endpoint] ??= {};
      if (options.web[endpoint] === "false") {
        config.web[endpoint] = false;
      }
      for (const property in options.web[endpoint]) {
        config.web[endpoint][property] = options.web[endpoint][property];
      }
    }
  }
  return config;
}

if (import.meta.main) {
  const host = await createScuttlebuttHost();
  host.start();
}

function getDefaultConfig(baseDir: string) {
  return {
    baseDir,
    transport: {
      net: {
        port: 8008,
      },
      ws: {
        web: ["access"],
      },
    },
    networkIdentifier: "1KHLiKZvAvjbY1ziZEHMXawbCEIM6qwjCDm3VYRan/s=",
    acceptIncomingConnections: true,
    web: {
      control: {
        port: 8990,
        hostname: "localhost",
      },
      access: {
        port: 8989,
        hostname: "0.0.0.0",
      },
    },
  };
}

async function getBaseConfig(options: Args) {
  //the windows place would be Deno.env.get("LOCALAPPDATA"), using Deno.env.get("UserProfile") for consistency
  const baseDir = options.baseDir
    ? options.baseDir
    : path.join(Deno.env.get("HOME") ?? Deno.env.get("UserProfile")!, ".ssb/");
  const defaultConfig = getDefaultConfig(baseDir);
  const configFile = path.join(baseDir, "config.json");
  if (await exists(configFile)) {
    const configText = await Deno.readTextFile(configFile);
    const configTextNoComments = configText.split("\n").filter((line) =>
      line.charAt(0) !== "#"
    ).join("\n");
    return Object.assign(defaultConfig, JSON.parse(configTextNoComments));
  } else {
    return defaultConfig;
  }
}
