// Replaces models/index.js. These two collections are the whole data layer, so
// this file is also the complete list of what the service persists.
module.exports = {
  aiSettingsStore: require("./aiSettingsStore").aiSettingsStore,
  aiInsightCacheStore: require("./aiInsightCacheStore").aiInsightCacheStore,
};
