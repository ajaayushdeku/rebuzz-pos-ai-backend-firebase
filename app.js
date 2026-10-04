const express = require("express");
const cors = require("cors");

const { assertFirestoreReady } = require("./configs/firestore");
const { assertEncryptionReady } = require("./helpers/aiCrypto");
const ApiRouter = require("./routes/api");

const PORT = Number(process.env.PORT ?? 4000);

/**
 * Everything that must be true before the server accepts a request.
 *
 * Checked here rather than lazily: a service that boots without a valid
 * AI_ENCRYPTION_KEY would accept writes it can never decrypt, and the damage
 * is only discovered when someone tries to read one back.
 */
function assertConfigured() {
  const missing = ["POS_API_URL"].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(", ")}`);
  }
  assertEncryptionReady();

  // Firestore replaced Mongo, so there is no MONGODB_URI and no connection to
  // open — the Admin SDK dials lazily. This only warns, because on Cloud Run
  // the credential comes from the runtime and no env var is set at all.
  assertFirestoreReady();

  // CORS_ORIGIN is where the frontend runs. It is inert while the only caller
  // is the Next.js proxy (server-to-server fetches send no Origin header), but
  // a browser calling this service directly with the fallback still set gets a
  // silent CORS block. Fail loudly at boot instead, unless explicitly allowed.
  if (
    process.env.NODE_ENV === "production" &&
    !process.env.CORS_ORIGIN &&
    process.env.ALLOW_DEFAULT_CORS !== "true"
  ) {
    throw new Error(
      "CORS_ORIGIN is not set: refusing to boot in production with the localhost fallback. " +
        "Set CORS_ORIGIN to the frontend origin, or ALLOW_DEFAULT_CORS=true if this service is never called by a browser.",
    );
  }
}

const app = express();

app.use(
  cors({
    // One named origin, not "*" — these routes carry a bearer token.
    // Inert while the only caller is the Next.js proxy, which sends no Origin
    // header; the fallback matters as soon as a browser calls this directly.
    origin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
    credentials: true,
  }),
);

// Small cap: the largest legitimate body here is a briefing of a few KB.
app.use(express.json({ limit: "256kb" }));

/**
 * Method, path and status only.
 *
 * Deliberately never the body: two routes carry a raw Gemini key in theirs,
 * and body-logging middleware is the most common way credentials reach a log
 * file. Path and status are enough to answer "did the request arrive", which
 * is otherwise invisible when a route fails before doing any work of its own.
 */
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    console.info(
      `[req] ${req.method} ${req.originalUrl} → ${res.statusCode} (${
        Date.now() - startedAt
      }ms)`,
    );
  });
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", ApiRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "NOT_FOUND" });
});

// Controllers answer their own failures (Express 4 does not forward a
// rejected promise); this catches the rest, such as a malformed JSON body.
app.use((error, _req, res, _next) => {
  // Message only. Error objects from the provider SDK can echo the request
  // back, key included.
  console.error("[error]", error?.message ?? error);
  res.status(500).json({ error: "INTERNAL_ERROR" });
});

async function start() {
  assertConfigured();

  const server = app.listen(PORT, () => {
    console.info(`[server] listening on http://localhost:${PORT}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      console.info(`[server] ${signal} — shutting down`);
      // Nothing to close behind the server: Firestore's channels are torn
      // down with the process, and there is no connection pool to drain.
      server.close(() => {
        process.exit(0);
      });
    });
  }
}

start().catch((error) => {
  console.error("[server] failed to start:", error.message);
  process.exit(1);
});
