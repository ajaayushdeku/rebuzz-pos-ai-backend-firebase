const { FieldValue } = require("firebase-admin/firestore");

const { db, COLLECTIONS } = require("../configs/firestore");
const {
  DEFAULT_PROVIDER,
  PROVIDER_IDS,
  getProvider,
} = require("../helpers/aiProviders");
const { datesFromTimestamps, expandFieldPaths, isNotFound } = require("./values");

/**
 * Each business's provider, model and encrypted key.
 *
 * Replaces `models/aiSettings.js`. Three things the Mongoose schema did are now
 * this file's job, because Firestore has no schema:
 *
 *   - **uniqueness.** The document id *is* the business id, so there can only
 *     ever be one record per business and every lookup is a `get()` — no query,
 *     no index, and the cheapest read Firestore offers.
 *   - **defaults.** A provider block the business has never touched is absent
 *     from the document. `hydrate` fills it in, so `settings.openrouter.model`
 *     reads the same as it did under Mongoose rather than throwing.
 *   - **`timestamps: true`.** `updatedAt` is written on every change below.
 *     `createdAt` is deliberately dropped: with `set(..., { merge: true })`
 *     there is no "write only if absent", so it would reset on every save, and
 *     nothing reads it. A field that quietly lies is worse than one that is
 *     missing.
 *
 * The encryption is unchanged and still the application's own: Firestore's
 * at-rest encryption protects the disks, not a console session or an export.
 * Only the `{ ciphertext, iv, authTag, keyVersion }` map is stored, exactly as
 * Mongo stored it.
 */

const ref = (businessId) => db.collection(COLLECTIONS.settings).doc(businessId);

/** What Mongoose's `providerCredentialsSchema` defaults gave a fresh block. */
const defaultCredentials = (providerId) => ({
  enabled: true,
  model: getProvider(providerId).defaultModel,
  apiKey: null,
  maskedKey: null,
  lastVerifiedAt: null,
});

/**
 * The only shape allowed to leave the server.
 *
 * Carried over verbatim from the model's `formatted()` method, including its
 * reason for existing: controllers return this rather than the document, so a
 * field added later cannot leak by default. The `req` the old method accepted
 * was never used, and call sites still pass it — harmlessly.
 */
function formatted() {
  const active = this.active();
  return {
    provider: this.provider ?? DEFAULT_PROVIDER,
    configured: Boolean(active?.apiKey),
    enabled: Boolean(active?.enabled),
    model: active?.model ?? null,
    maskedKey: active?.maskedKey ?? null,
    lastVerifiedAt: active?.lastVerifiedAt ?? null,
    updatedAt: this.updatedAt,
  };
}

/** The credentials for the provider in use. */
function active() {
  return this[this.provider] ?? this.gemini;
}

/**
 * Belt and braces, as the model's `toJSON` transform was: if a settings object
 * is ever serialised directly — a stray `res.json(settings)`, a logger that
 * stringifies its input — the ciphertext does not travel with it.
 */
function toJSON() {
  const out = {};
  for (const [key, value] of Object.entries(this)) {
    out[key] = PROVIDER_IDS.includes(key) ? { ...value, apiKey: undefined } : value;
  }
  return out;
}

/** The three helpers above, hidden from `Object.entries` and from JSON. */
const withMethods = (settings) =>
  Object.defineProperties(settings, {
    active: { value: active },
    formatted: { value: formatted },
    toJSON: { value: toJSON },
  });

function hydrate(snapshot) {
  if (!snapshot?.exists) return null;

  const stored = datesFromTimestamps(snapshot.data()) ?? {};

  const settings = {
    // From the id, not a field: the document id is the business id, so storing
    // it twice invites the two disagreeing.
    businessId: snapshot.id,
    adminId: stored.adminId ?? null,
    // Gemini for every record written before there was a choice, matching the
    // schema default that made those records keep working.
    provider: stored.provider ?? DEFAULT_PROVIDER,
    updatedAt: stored.updatedAt ?? null,
  };

  for (const providerId of PROVIDER_IDS) {
    settings[providerId] = {
      ...defaultCredentials(providerId),
      ...(stored[providerId] ?? {}),
    };
  }

  return withMethods(settings);
}

const aiSettingsStore = {
  /** One business's settings, or null if AI was never configured. */
  async findByBusinessId(businessId) {
    return hydrate(await ref(businessId).get());
  },

  /**
   * Create or amend, and return the result — Mongoose's
   * `findOneAndUpdate(…, { new: true, upsert: true })`.
   *
   * `update` is the same dotted-path object the controller already built; see
   * `expandFieldPaths` for why it cannot be handed to `set()` as it is.
   */
  async upsert(businessId, update) {
    const target = ref(businessId);

    await target.set(
      expandFieldPaths({
        ...update,
        // Server time, not this process's clock: two instances with drifting
        // clocks would otherwise write an `updatedAt` that goes backwards.
        updatedAt: FieldValue.serverTimestamp(),
      }),
      { merge: true },
    );

    // Re-read rather than echo the input: the merged document is what the
    // caller asked for, and the sentinel above only becomes a time here.
    return hydrate(await target.get());
  },

  /**
   * Amend an existing record, or report that there is none —
   * `findOneAndUpdate(…, { new: true })`, which returned null for a miss.
   *
   * Dotted keys pass straight through: `update()` reads them as paths into the
   * nested provider map, which is exactly what the controllers mean by
   * `"gemini.enabled"`.
   */
  async patch(businessId, update) {
    const target = ref(businessId);

    try {
      await target.update({ ...update, updatedAt: FieldValue.serverTimestamp() });
    } catch (error) {
      // Mongo answered a missing document with null; Firestore throws. The
      // callers' 404 NOT_CONFIGURED depends on getting null back.
      if (isNotFound(error)) return null;
      throw error;
    }

    return hydrate(await target.get());
  },
};

module.exports = { aiSettingsStore };
