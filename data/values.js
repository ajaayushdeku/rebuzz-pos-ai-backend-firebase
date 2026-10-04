const { Timestamp } = require("firebase-admin/firestore");

/**
 * Firestore returns dates as `Timestamp`, Mongoose returned them as `Date`.
 *
 * Every read goes through this, so nothing downstream has to know which
 * database it is talking to. Two call sites would otherwise break quietly:
 * `generatedAt.toISOString()` in the insights controller (a `Timestamp` has no
 * such method), and `lastVerifiedAt` in `formatted()`, which goes straight into
 * a JSON reply — a `Timestamp` serialises as `{_seconds, _nanoseconds}`, which
 * the frontend reads as an invalid date rather than as an error.
 */
function datesFromTimestamps(value) {
  if (value instanceof Timestamp) return value.toDate();
  if (Array.isArray(value)) return value.map(datesFromTimestamps);
  // Only plain objects: a Timestamp is caught above, and `insights` holds
  // whatever shape the caller's schema asked for, so this walks it too.
  if (value && typeof value === "object" && value.constructor === Object) {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = datesFromTimestamps(inner);
    }
    return out;
  }
  return value;
}

/**
 * `{ "gemini.apiKey": x }` → `{ gemini: { apiKey: x } }`.
 *
 * The trap this exists for: `update()` reads a dotted string key as a path into
 * a nested map, but `set()` does **not** — it would create a field whose name
 * literally contains a dot, leaving the real `gemini.apiKey` untouched and the
 * document holding two versions of the same thing. So the upsert path (`set`
 * with merge) expands first, and the update path passes dots through as they
 * are. Both write shapes stay the dotted one the controllers already build.
 */
function expandFieldPaths(update) {
  const nested = {};

  for (const [path, value] of Object.entries(update)) {
    const parts = path.split(".");
    let cursor = nested;
    while (parts.length > 1) {
      const part = parts.shift();
      if (cursor[part] === undefined) cursor[part] = {};
      cursor = cursor[part];
    }
    cursor[parts[0]] = value;
  }

  return nested;
}

/** Firestore's code for "no such document", as thrown by `update()`. */
const NOT_FOUND = 5;

const isNotFound = (error) =>
  error?.code === NOT_FOUND || /NOT_FOUND/.test(String(error?.message ?? ""));

module.exports = { datesFromTimestamps, expandFieldPaths, isNotFound };
