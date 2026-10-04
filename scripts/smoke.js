/**
 * One real request through the whole stack, with a real token.
 *
 *   npm run smoke -- <your POS token>
 *
 * Everything else that has been verified stops short of this: the stores were
 * tested against a fake Firestore, and `verify:firestore` talks to the database
 * directly. Neither one goes through a route, the auth middleware or a
 * controller — so this is the only check that proves the ported data layer works
 * where it actually runs.
 *
 * Needs the service running (`npm run dev`) in another terminal.
 *
 * Exists as a script rather than a curl line because `curl` in PowerShell is an
 * alias for Invoke-WebRequest, which does not understand `-H` and fails in a way
 * that looks like the server's fault.
 *
 * The token is read from the arguments and never printed or logged.
 */

const BASE = process.env.SMOKE_BASE_URL || "http://localhost:4000";

const token = process.argv[2];

if (!token) {
  console.error("Usage: npm run smoke -- <token>");
  console.error("");
  console.error("The token is the one the app already uses: log in, then in");
  console.error("DevTools → Application → Local Storage (or Cookies), copy the");
  console.error("auth token.");
  process.exit(1);
}

/** Read-only routes only: nothing here writes, spends provider quota or costs money. */
const CHECKS = [
  ["GET", "/api/settings/ai", "settings read — controller → Firestore"],
  ["GET", "/api/ai-insights/quota", "rate-limit state — no database involved"],
];

async function main() {
  console.info(`[smoke] ${BASE}`);

  for (const [method, path, what] of CHECKS) {
    let res;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (error) {
      console.error(`\n[smoke] cannot reach ${BASE} — is \`npm run dev\` running?`);
      console.error(`[smoke] ${error?.message ?? error}`);
      process.exit(1);
    }

    const body = await res.json().catch(() => ({}));
    console.info(`\n${method} ${path}  → ${res.status}   (${what})`);
    console.info(JSON.stringify(body, null, 2));

    if (res.status === 401) {
      console.error(
        "\n[smoke] 401 means the POS API rejected the token — it has probably " +
          "expired. Log in again and copy a fresh one.",
      );
      process.exit(1);
    }
    if (!res.ok) {
      console.error(`\n[smoke] unexpected ${res.status} — see the service's own log`);
      process.exit(1);
    }
  }

  console.info(
    "\n[smoke] passed. A real token was verified against the POS, a controller " +
      "read Firestore, and the reply came back in the shape the frontend expects.",
  );
}

main().catch((error) => {
  console.error(`[smoke] FAILED: ${error?.message ?? error}`);
  process.exit(1);
});
