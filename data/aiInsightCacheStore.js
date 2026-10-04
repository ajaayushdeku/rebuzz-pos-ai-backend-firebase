const { db, COLLECTIONS } = require("../configs/firestore");
const { datesFromTimestamps } = require("./values");

/**
 * Generated insights, kept so the same question is not paid for twice.
 *
 * Replaces `models/aiInsightCache.js`. What moved, and why:
 *
 *   - **The unique index became the document id.** Mongo enforced one answer
 *     per `{ businessId, cacheKey }` with a compound unique index; here the id
 *     is `{businessId}__{cacheKey}`, which gives the same guarantee and turns
 *     the cache hit into a `get()` — no query and no index to maintain.
 *   - **The regex prefix search became a stored `section` field.** See
 *     `findLastAnswer` below.
 *   - **The TTL index became a TTL policy** on `expiresAt`. Firestore's sweeper
 *     runs up to 24 hours late, so an expired answer stays readable in the
 *     meantime and every read here still filters on `expiresAt` itself. Do not
 *     remove those filters on the grounds that the policy covers it.
 */

const collection = () => db.collection(COLLECTIONS.insightCache);

/**
 * `{businessId}__{cacheKey}`.
 *
 * Safe as an id: the cache key's alphabet is validated at the route to
 * `[A-Za-z0-9:._-]`, so it can hold no `/`, and the business id in front means
 * the result can never be `.`, `..`, or match Firestore's reserved `__…__`.
 */
const idFor = (businessId, cacheKey) => `${businessId}__${cacheKey}`;

/**
 * The part of a cache key that identifies the section and the prompt version.
 *
 * A key is `"section:version:date"`, so this is everything up to the last colon
 * — "sales-recommendations:v1:". Stored as its own field at write time and
 * matched by equality at read time, because Firestore has no regex, and the
 * usual prefix trick (`>= p`, `< p + "\uf8ff"`) cannot be combined with sorting
 * on `generatedAt`: the first `orderBy` must be the inequality's own field.
 *
 * Both the read and the write call this one function, so the two can never
 * disagree about where the key is cut. Keeping the version in it is deliberate:
 * a prompt-version bump must not serve answers written by the old prompt.
 */
const sectionOf = (cacheKey) => cacheKey.slice(0, cacheKey.lastIndexOf(":") + 1);

function hydrate(snapshot) {
  if (!snapshot?.exists) return null;
  return { id: snapshot.id, ...datesFromTimestamps(snapshot.data()) };
}

const aiInsightCacheStore = {
  /**
   * The answer stored under exactly this key, if it has not expired.
   *
   * A direct `get()` — Mongo's `findOne({ businessId, cacheKey, expiresAt: {
   * $gt: now } })`, with the expiry checked here rather than in the query,
   * since a lookup by id cannot carry a filter.
   */
  async findFresh(businessId, cacheKey) {
    const hit = hydrate(await collection().doc(idFor(businessId, cacheKey)).get());
    if (!hit) return null;
    // Still here only because Firestore's TTL sweeper has not got to it yet.
    if (!hit.expiresAt || hit.expiresAt.getTime() <= Date.now()) return null;
    return hit;
  },

  /**
   * The newest unexpired answer this business has for the same section and
   * prompt version, whichever provider, model or day wrote it.
   *
   * Deliberately looser than `findFresh`: a card written by the previous model,
   * or yesterday, still describes this business's own sales — an empty panel
   * describes nothing.
   *
   * The sort is `expiresAt` then `generatedAt`, not `generatedAt` alone, because
   * the inequality field has to lead. Since every answer is written with the
   * same fixed TTL, `expiresAt` moves in step with `generatedAt` and the order
   * works out the same; it would only diverge if the TTL were ever varied per
   * answer. This is the open question from step 3, left as it is for now.
   */
  async findLastAnswer(businessId, cacheKey) {
    const section = sectionOf(cacheKey);
    if (!section) return null;

    const found = await collection()
      .where("businessId", "==", businessId)
      .where("section", "==", section)
      .where("expiresAt", ">", new Date())
      .orderBy("expiresAt", "desc")
      .orderBy("generatedAt", "desc")
      .limit(1)
      .get();

    return found.empty ? null : hydrate(found.docs[0]);
  },

  /**
   * Keep an answer under its key — `findOneAndUpdate(…, { upsert: true })`.
   *
   * `set` without merge, on purpose: a cache entry is replaced whole, and a
   * merge would leave fields from the answer it supersedes.
   */
  async save(businessId, cacheKey, entry) {
    await collection()
      .doc(idFor(businessId, cacheKey))
      .set({
        businessId,
        cacheKey,
        // Only used by findLastAnswer, and derived rather than passed in so a
        // caller cannot write a section the search will not find.
        section: sectionOf(cacheKey),
        ...entry,
      });
  },
};

module.exports = { aiInsightCacheStore, sectionOf };
