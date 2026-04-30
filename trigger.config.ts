import { defineConfig } from "@trigger.dev/sdk/v3";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";

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
  build: {
    // Without this extension Trigger's bundler tree-shakes Prisma's `.node`
    // engine and the deployed worker panics with "could not locate the
    // Query Engine for runtime debian-openssl-3.0.x". The legacy-mode
    // extension runs `prisma generate` during the deploy build *and* copies
    // the right engine binary next to the bundle.
    extensions: [
      prismaExtension({
        mode: "legacy",
        schema: "prisma/schema.prisma",
        // Vercel's Prisma-Postgres marketplace injects POSTGRES_URL as the
        // unpooled / direct connection string. Pointing the extension at
        // it silences the build-time DATABASE_URL warning. Migration
        // application is left to a separate manual `prisma migrate deploy`
        // run (see DEPLOYMENT.md step 2).
        directUrlEnvVarName: "POSTGRES_URL",
      }),
    ],
  },
});
