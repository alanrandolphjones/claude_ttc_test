// The ghost tracker's 14-day summary (route ghost rates, feed biases), published by the Ghost
// tracker workflow to the ghost-data branch. Refreshed every 6 hours.
const URL_SUMMARY = 'https://raw.githubusercontent.com/alanrandolphjones/claude_ttc_test/ghost-data/summary.json';
const CACHE_MS = 6 * 3600 * 1000;
let cache = { at: 0, body: null };

async function getGhostStats() {
  if (cache.body && Date.now() - cache.at < CACHE_MS) return cache.body;
  try {
    const res = await fetch(URL_SUMMARY);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.text();
    JSON.parse(body);
    cache = { at: Date.now(), body };
  } catch (e) {
    if (!cache.body) throw e;                      // keep serving the last copy
    cache.at = Date.now() - CACHE_MS + 15 * 60e3;  // retry in 15 minutes
  }
  return cache.body;
}

module.exports = { getGhostStats };
