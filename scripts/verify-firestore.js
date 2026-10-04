/**
 * Proves the credential and the deployed index work, before any controller
 * depends on them.
 *
 *   npm run verify:firestore
 *
 * Checks four things, in the order they can fail:
 *   1. the credential is accepted at all
 *   2. the NAMED database `default` exists (a bare getFirestore() 404s here)
 *   3. a write and a read-back round-trip
 *   4. the composite index in ../firebase/firestore.indexes.json is live —
 *      a missing index fails with FAILED_PRECONDITION and a link to create it
 *
 * The probe document is deleted afterwards. Firestore collections exist only
 * while they hold documents, so nothing is left behind.
 */

const { Timestamp, FieldValue } = require("firebase-admin/firestore");
const { db, COLLECTIONS, DATABASE_ID } = require("../configs/firestore");

// Not "__verify__": Firestore reserves every document id matching `__…__`,
// and a reserved id fails with INVALID_ARGUMENT rather than anything that
// mentions ids. The real ids are `{businessId}__{cacheKey}`, which cannot
// collide with that pattern because the business id comes first.
const PROBE_ID = "zz-verify-probe";

async function main() {
  console.info(`[verify] database: ${DATABASE_ID}`);

  const ref = db.collection(COLLECTIONS.insightCache).doc(PROBE_ID);
  const now = Timestamp.now();

  await ref.set({
    businessId: PROBE_ID,
    section: "zz-verify:v0:",
    cacheKey: PROBE_ID,
    insights: { ok: true },
    model: null,
    settingsModel: "verify:none",
    generatedAt: now,
    // An hour out, so the probe would satisfy the `expiresAt > now` filter the
    // real read path uses.
    expiresAt: Timestamp.fromMillis(now.toMillis() + 60 * 60 * 1000),
    writtenBy: FieldValue.serverTimestamp(),
  });
  console.info("[verify] write    ok");

  const snap = await ref.get();
  if (!snap.exists) throw new Error("wrote a document but could not read it back");
  // Timestamps come back as Timestamp, never Date — the likeliest quiet bug in
  // the port, so the round-trip asserts the type rather than assuming it.
  if (!(snap.get("generatedAt") instanceof Timestamp)) {
    throw new Error("generatedAt did not round-trip as a Timestamp");
  }
  console.info("[verify] read     ok");

  const query = await db
    .collection(COLLECTIONS.insightCache)
    .where("businessId", "==", PROBE_ID)
    .where("section", "==", "zz-verify:v0:")
    .where("expiresAt", ">", Timestamp.now())
    // The inequality field must lead the sort, so this is expiresAt first and
    // generatedAt second — both descending, matching the deployed index
    // exactly. Ascending here would be served by the same index but would
    // return the answer nearest to expiring, i.e. the oldest.
    .orderBy("expiresAt", "desc")
    .orderBy("generatedAt", "desc")
    .limit(1)
    .get();
  if (query.empty) throw new Error("index query returned nothing, expected the probe");
  console.info("[verify] index    ok");

  await ref.delete();
  console.info("[verify] cleanup  ok");
  console.info("[verify] all checks passed");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[verify] FAILED: ${error?.message ?? error}`);
    if (error?.code === 5 || /NOT_FOUND/i.test(String(error?.message))) {
      console.error(
        "[verify] NOT_FOUND usually means the database id is wrong. This project's " +
          "database is named `default`, not `(default)`.",
      );
    }
    if (/FAILED_PRECONDITION/i.test(String(error?.message))) {
      console.error(
        "[verify] FAILED_PRECONDITION means the composite index is missing. From " +
          "../firebase: firebase deploy --only firestore:indexes",
      );
    }
    process.exit(1);
  });
