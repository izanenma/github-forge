// Entry point: the forge runs as one process. It boots the HTTP server built by
// app.ts, binds an ephemeral port, registers that port with the trial env, and
// then waits until the env reports the trial is done. Nothing else lives here
// on purpose: every scored behaviour belongs to the server this file starts.
//
// The env is named by MAKEFUN_ENV_URL. The contract, step by step:
//   - no MAKEFUN_ENV_URL -> exit 1 at once, there is nothing to join.
//   - listen(0): the kernel picks the port. Port 8080 belongs to the env.
//   - POST {env}/register {"port": N}. The first registration wins; a 409 means
//     another entry registered first, and this process simply waits it out.
//   - GET {env}/done until the body is {"done": true}. Polls are cheap and
//     answered immediately, so a failed poll is retried with exponential
//     backoff instead of ever ending the process early.
//   - close the server, exit 0. The harness stops the env after that.
//
// Only app.ts is imported: no other package, no Node built-in, no model call.

import { createApp } from "./app.ts";

const ENV = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
if (ENV === "") {
  process.stderr.write("[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n");
  process.exit(1);
}

/** How long one register or done request may run before it is abandoned and retried. */
const FETCH_TIMEOUT_MS = 30_000;
/** First backoff step between retries, and the longest step. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Backoff after `attempt` failed requests: exponential from BACKOFF_FIRST_MS, capped. */
function backoff(attempt: number): number {
  const step = Math.min(attempt, 8);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** step);
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer and
 * 409 means a first register already won, which is not this process's to fix.
 * 400 and 405 are contract errors and end the program; a network error or any
 * other status is retried, since the env may still be starting up.
 */
async function registerPort(port: number): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(`${ENV}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("register answered HTTP ")) throw err;
    }
    await pause(backoff(attempt));
    attempt += 1;
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function pollDone(): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(`${ENV}/done`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Env quiet or slow: not done yet, so keep polling.
    }
    await pause(backoff(attempt));
    attempt += 1;
  }
}

/** Bind the port, register it, then wait for the env: the whole life of the process. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("the server did not bind an ephemeral TCP port");
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await registerPort(bound.port);
  process.stdout.write("[entry] registered; waiting for the env to say done\n");

  await pollDone();
  server.close();
  process.stdout.write("[entry] done\n");
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
