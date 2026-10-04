const { initializeApp, applicationDefault, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

/**
 * The Firestore handle, created once at module load.
 *
 * Replaces `dbConnection.js`. There is nothing to await and nothing to connect:
 * the Admin SDK opens channels lazily and reuses them, so this module has no
 * `connectDatabase()` for `app.js` to call before accepting requests.
 *
 * The Admin SDK is not subject to the security rules in firebase/ — those deny
 * every client, and this bypassing them is how the server gets in at all. That
 * is also why the credential below is as sensitive as the database itself.
 */

/** The database is NAMED `default`, not `(default)` — see firebase/README.md. */
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || "default";

/**
 * Set by hand in .env — or automatically by `firebase emulators:exec` — to send
 * every read and write to a Firestore running on this machine instead of the
 * real one. The SDK reads this variable itself; nothing below has to route
 * anything. Unset, this file behaves exactly as it did before.
 */
const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST;

/**
 * The project the emulator pretends to be, which matters only because the SDK
 * refuses to start without a project from somewhere.
 */
const PROJECT_ID =
  process.env.FIRESTORE_PROJECT_ID ||
  process.env.GCLOUD_PROJECT ||
  "rebuzz-backoffice-ai-backend";

/**
 * Where the credential comes from, in the order it is looked for.
 *
 * 1. `FIREBASE_SERVICE_ACCOUNT` — the whole service-account JSON in one variable.
 *    For hosts that give you env vars but no writable filesystem.
 * 2. Application Default Credentials — a `GOOGLE_APPLICATION_CREDENTIALS` path
 *    in development, or the runtime's own service account on Cloud Run and
 *    Cloud Functions, where there is nothing to configure at all.
 *
 * The JSON's `private_key` carries real newlines. Passed through an env var they
 * arrive as the two characters `\` and `n`, and the SDK then fails to parse the
 * key with an error that does not mention newlines — so they are put back here.
 */
function credential() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return applicationDefault();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON. It must hold the " +
        "whole service-account file, not a path to it.",
    );
  }

  if (parsed.private_key) {
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  }

  return cert(parsed);
}

/**
 * No credential when talking to the emulator.
 *
 * It authenticates nothing, and asking for a credential anyway would fail on a
 * machine that has no key at all — which is half the reason to run it.
 */
const app = initializeApp(
  EMULATOR_HOST ? { projectId: PROJECT_ID } : { credential: credential() },
);

if (EMULATOR_HOST) {
  // Loud on purpose. The failure this prevents is a long debugging session over
  // data that was written to a database which disappears when the emulator
  // stops — or the reverse, a test believed to be local that was not.
  console.warn(`[firestore] EMULATOR at ${EMULATOR_HOST} — real data is NOT touched`);
}

const db = getFirestore(app, DATABASE_ID);

db.settings({
  // Mongoose dropped `undefined` fields; Firestore throws on them. Writes here
  // are built by spreading partial objects, so this keeps the shape of the
  // existing controller code working unchanged.
  ignoreUndefinedProperties: true,
});

/**
 * Fails at boot rather than on the first request.
 *
 * Mirrors what `assertConfigured()` does for the rest of the service: a missing
 * credential is a deployment mistake, and finding out when a merchant clicks
 * Generate is the worst time to find out.
 */
function assertFirestoreReady() {
  // The emulator needs no credential, so its absence is not worth mentioning.
  if (EMULATOR_HOST) return;

  if (!process.env.FIREBASE_SERVICE_ACCOUNT && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Not fatal on Cloud Run or Functions, where the runtime supplies the
    // credential and neither variable is set — hence a warning, not a throw.
    console.warn(
      "[firestore] no FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS. " +
        "Expected only on Cloud Run / Cloud Functions, where the runtime provides one.",
    );
  }
}

/** Collection names, in one place so a typo cannot create a second collection. */
const COLLECTIONS = {
  settings: "aiSettings",
  insightCache: "aiInsightCache",
};

module.exports = {
  db,
  COLLECTIONS,
  DATABASE_ID,
  assertFirestoreReady,
  /** True when this process is pointed at the local emulator. */
  usingEmulator: Boolean(EMULATOR_HOST),
};
