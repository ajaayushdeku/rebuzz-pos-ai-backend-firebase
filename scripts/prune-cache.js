/**
 * Deletes expired cache entries — what the TTL policy would have done.
 *
 *   npm run cache:prune          delete them
 *   npm run cache:prune -- --dry list them, delete nothing
 *
 * Why this exists rather than the TTL policy: the policy needs a plan and a
 * permission this project does not have (no TTL tab in the console on Spark, and
 * the service account cannot set it through the API — see scripts/enable-ttl.js).
 * Nothing is lost by doing it here. Firestore's own sweeper runs up to 24 hours
 * late anyway, which is why every read in data/aiInsightCacheStore.js filters on
 * `expiresAt` regardless.
 *
 * Safe to run at any time, including while the service is live: an expired
 * document is already invisible to every read path, so deleting one cannot
 * change an answer anybody sees.
 *
 * It uses the single-field index Firestore maintains automatically, so there is
 * nothing to deploy for it.
 */

const { db, COLLECTIONS } = require("../configs/firestore");

/** Firestore caps a batch at 500 writes; 300 leaves room and keeps runs short. */
const BATCH_SIZE = 300;

const dryRun = process.argv.includes("--dry");

async function main() {
  const collection = db.collection(COLLECTIONS.insightCache);
  const cutoff = new Date();

  let scanned = 0;
  let removed = 0;

  // One page at a time, deleting as it goes: loading every expired document
  // first would hold the whole collection in memory on the one run that matters,
  // the first one after this has never been run.
  for (;;) {
    const page = await collection
      .where("expiresAt", "<", cutoff)
      .limit(BATCH_SIZE)
      .get();

    if (page.empty) break;
    scanned += page.size;

    if (dryRun) {
      for (const doc of page.docs) {
        const expired = doc.get("expiresAt")?.toDate?.();
        console.info(`  would delete ${doc.id}  (expired ${expired?.toISOString()})`);
      }
      // Nothing was deleted, so the same page would come back forever.
      if (page.size < BATCH_SIZE) break;
      console.info("  … more remain; re-run without --dry to delete");
      break;
    }

    const batch = db.batch();
    for (const doc of page.docs) batch.delete(doc.ref);
    await batch.commit();
    removed += page.size;
    console.info(`[prune] deleted ${removed}`);
  }

  if (scanned === 0) {
    console.info("[prune] nothing expired");
    return;
  }
  console.info(
    dryRun
      ? `[prune] ${scanned} expired (dry run, nothing deleted)`
      : `[prune] done, ${removed} deleted`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[prune] FAILED: ${error?.message ?? error}`);
    process.exit(1);
  });
