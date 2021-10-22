import ScuttlebuttHost from "./ScuttlebuttHost.ts";
import { exists, log, path } from "./util.ts";
import { parse } from "https://deno.land/std@0.112.0/flags/mod.ts";

/* starts an SSB peer configured according to command line options */

const options = parse(Deno.args, {
  /*boolean: "incoming"*/
});

await configureLogging();

//read base config from file, use defaults if missing
const config = await getBaseConfig();

//adapt config according to params
if (typeof (options.incoming) !== "undefined") {
  config.acceptIncomingConnections = options.incoming.toLowerCase() === "true";
}

const host = new ScuttlebuttHost(config);
host.start();

//functions
async function configureLogging() {
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
    },
    networkIdentifier: "1KHLiKZvAvjbY1ziZEHMXawbCEIM6qwjCDm3VYRan/s=",
    acceptIncomingConnections: true,
  };
}

async function getBaseConfig() {
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
