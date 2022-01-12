import DenoScuttlebuttHost from "./DenoScuttlebuttHost.ts";
import { exists, log, path } from "./util.ts";
import { Args, parse } from "https://deno.land/std@0.112.0/flags/mod.ts";

/* return an SSB peer configured according to command line options */
export async function createScuttlebuttHost() {
  const options = parse(Deno.args, {
    /*boolean: "incoming"*/
  });
  await configureLogging(options);

  //read base config from file, use defaults if missing
  const config = await getBaseConfig(options);

  //adapt config according to params
  if (typeof (options.incoming) !== "undefined") {
    config.acceptIncomingConnections =
      options.incoming.toLowerCase() === "true";
  }
  if (typeof (options.control?.web) !== "undefined") {
    config.control ??= {};
    if (options.control?.web === "false") {
      config.control.web = false;
    }
    if (options.control?.web?.port) {
      config.control.web.port = options.control?.web?.port;
    }
    if (options.control?.web?.hostname) {
      config.control.web.hostname = options.control?.web?.hostname;
    }
  }

  return new DenoScuttlebuttHost(config);
}

if (import.meta.main) {
  const host = await createScuttlebuttHost();
  host.start();
}

async function configureLogging(options: Args) {
  const logLevel = options.logLevel ? options.logLevel : "DEBUG";
  await log.setup({
    handlers: {
      console: new log.handlers.ConsoleHandler(logLevel),
    },
    loggers: {
      default: {
        level: logLevel,
        handlers: ["console"],
      },
    },
  });
  log.info(`Log level of set to ${logLevel}`);
}

function getDefaultConfig(baseDir: string) {
  const dataDir = path.join(baseDir, "data/");
  return {
    baseDir,
    dataDir,
    transport: {
      net: {
        port: 8008,
      },
      ws: {
        port: 8989,
      },
    },
    networkIdentifier: "1KHLiKZvAvjbY1ziZEHMXawbCEIM6qwjCDm3VYRan/s=",
    acceptIncomingConnections: true,
    control: {
      web: {
        port: 8000,
        hostname: "localhost",
      },
    },
  };
}

async function getBaseConfig(options: Args) {
  const baseDir = options.baseDir
    ? options.baseDir
    : path.join(Deno.env.get("HOME")!, ".ssb/");
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
