import {
  defineConfig
} from "../../chunk-ZLZOJIGJ.mjs";
import "../../chunk-WZGQJWAS.mjs";
import {
  init_esm
} from "../../chunk-FUV6SSYK.mjs";

// trigger.config.ts
init_esm();
var trigger_config_default = defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_qcoigvbczcabygdncuqb",
  runtime: "node",
  logLevel: "log",
  maxDuration: 600,
  retries: {
    enabledInDev: false,
    default: { maxAttempts: 1, factor: 1, minTimeoutInMs: 1e3, maxTimeoutInMs: 1e3, randomize: false }
  },
  dirs: ["./src/trigger"],
  build: {}
});
var resolveEnvVars = void 0;
export {
  trigger_config_default as default,
  resolveEnvVars
};
//# sourceMappingURL=trigger.config.mjs.map
