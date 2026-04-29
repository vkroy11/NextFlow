import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_qcoigvbczcabygdncuqb",
  runtime: "node",
  logLevel: "log",
  maxDuration: 600,
  retries: {
    enabledInDev: false,
    default: { maxAttempts: 1, factor: 1, minTimeoutInMs: 1000, maxTimeoutInMs: 1000, randomize: false },
  },
  dirs: ["./src/trigger"],
});
