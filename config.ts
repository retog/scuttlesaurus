import { log, path } from "./util.ts";

log.setup({
  handlers: {
    console: new log.handlers.ConsoleHandler("DEBUG"),
  },
  loggers: {
    default: {
      level: "DEBUG",
      handlers: ["console"],
    },
  },
});

const baseDir = path.join(Deno.env.get("HOME")!, ".ssb/");
const dataDir = path.join(baseDir, "data/");

const config = {
  baseDir,
  dataDir,
  port: 8008,
};

export default config;
