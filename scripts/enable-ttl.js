/**
 * Turns on the TTL policy that deletes expired cache entries.
 *
 *   npm run ttl:enable
 *
 * A file rather than a console click, for the same reason the rules and indexes
 * are files: a setting nobody can find is a setting nobody can review. The
 * documented way is `gcloud firestore fields ttls update`, which would mean
 * installing the whole Cloud SDK to send one PATCH — so this sends it directly,
 * using the service-account credential already in .env.
 *
 * Idempotent: if the policy is already there, it reports and changes nothing.
 *
 * Note what this does NOT do. Firestore's sweeper can run up to 24 hours after
 * `expiresAt`, so an expired answer stays readable until it does. The
 * `expiresAt` filters in `data/aiInsightCacheStore.js` are what actually make
 * expiry take effect; this only stops old answers accumulating and being paid
 * for as storage.
 */

const { GoogleAuth } = require("google-auth-library");

const { DATABASE_ID } = require("../configs/firestore");

const COLLECTION_GROUP = "aiInsightCache";
const FIELD = "expiresAt";

/** How long to watch the build before leaving it to finish on its own. */
const POLL_LIMIT = 10;
const POLL_INTERVAL_MS = 6_000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // Scoped to Datastore rather than cloud-platform: this token may only touch
  // Firestore, which is all it is for.
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/datastore"],
  });

  const client = await auth.getClient();
  const projectId = await auth.getProjectId();

  const name =
    `projects/${projectId}/databases/${DATABASE_ID}` +
    `/collectionGroups/${COLLECTION_GROUP}/fields/${FIELD}`;
  const url = `https://firestore.googleapis.com/v1/${name}`;

  console.info(`[ttl] project:  ${projectId}`);
  console.info(`[ttl] database: ${DATABASE_ID}`);
  console.info(`[ttl] field:    ${COLLECTION_GROUP}.${FIELD}`);

  const read = async () => {
    const res = await client.request({ url, method: "GET" });
    return res.data;
  };

  const before = await read();
  const state = before?.ttlConfig?.state;

  if (state === "ACTIVE") {
    console.info("[ttl] already ACTIVE — nothing to do");
    return;
  }
  if (state === "CREATING") {
    console.info("[ttl] already being built — waiting");
  } else {
    // `updateMask` is required and must name ttlConfig alone: without it the
    // request is read as "replace this field's whole configuration", which
    // would take the index settings with it.
    //
    // It is `updateMask=ttlConfig`, not `updateMask.fieldPaths=ttlConfig`. This
    // endpoint takes a FieldMask, which binds to a query string as a plain
    // comma-separated list; the `.fieldPaths` form belongs to the document API
    // and is rejected here.
    await client.request({
      url: `${url}?updateMask=ttlConfig`,
      method: "PATCH",
      // `name` is in the URL, and repeated in the body because this endpoint
      // takes the whole Field resource as its payload.
      data: { name, ttlConfig: {} },
    });
    console.info("[ttl] requested");
  }

  // Enabling TTL is a background build over the existing documents, so the
  // first read back is usually CREATING rather than ACTIVE.
  for (let attempt = 1; attempt <= POLL_LIMIT; attempt += 1) {
    const current = await read();
    const now = current?.ttlConfig?.state ?? "NONE";

    if (now === "ACTIVE") {
      console.info("[ttl] ACTIVE");
      return;
    }

    console.info(`[ttl] ${now} (${attempt}/${POLL_LIMIT})`);
    if (attempt < POLL_LIMIT) await wait(POLL_INTERVAL_MS);
  }

  console.info(
    "[ttl] still building. It finishes on its own; re-run this to check, or " +
      "see Firestore → TTL in the console.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    const detail = error?.response?.data?.error;
    console.error(`[ttl] FAILED: ${detail?.message ?? error?.message ?? error}`);

    if (detail?.status === "PERMISSION_DENIED") {
      console.error(
        "[ttl] the service account needs datastore.indexes.update — " +
          "roles/datastore.owner has it, roles/datastore.user does not. " +
          "Firestore → TTL in the console does the same job by hand.",
      );
    }
    process.exit(1);
  });
