/**
 * Message Deduplication with per-entry TTL.
 *
 * Each message ID is stored with its own expiry timestamp.
 * Expired entries are lazily evicted on access and periodically swept,
 * so the cache never bulk-clears and never loses recent entries.
 *
 * Usage:
 *   const { isDuplicate } = require('./messageDedup');
 *   if (isDuplicate(botId, messageId)) return; // already processed
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000;  // 10 minutes per entry
const SWEEP_INTERVAL_MS = 2 * 60 * 1000; // sweep every 2 minutes
const MAX_SIZE = 15_000;                  // hard cap to prevent memory leak

// Map<string, number>  —  key = "botId:msgId", value = expiresAt timestamp
const seen = new Map();

/**
 * Returns true if this (botId + messageId) combo was already processed.
 * If not, marks it as seen with a per-entry TTL.
 */
function isDuplicate(botId, messageId) {
    if (!messageId) return false;
    const key = `${botId || 'default'}:${messageId}`;
    const now = Date.now();

    const expiresAt = seen.get(key);
    if (expiresAt !== undefined) {
        if (expiresAt > now) return true; // still valid → duplicate
        // expired entry, fall through to re-register
    }

    // Evict oldest entries if we hit the hard cap
    if (seen.size >= MAX_SIZE) {
        let toDelete = Math.max(1, Math.floor(MAX_SIZE * 0.1));
        for (const k of seen.keys()) {
            if (toDelete-- <= 0) break;
            seen.delete(k);
        }
    }

    seen.set(key, now + DEFAULT_TTL_MS);
    return false;
}

/**
 * Periodic sweep of expired entries to reclaim memory.
 * Runs on a non-blocking interval.
 */
function sweep() {
    const now = Date.now();
    for (const [key, expiresAt] of seen) {
        if (expiresAt <= now) seen.delete(key);
    }
}

const _sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
if (_sweepTimer.unref) _sweepTimer.unref(); // don't keep process alive

module.exports = { isDuplicate, sweep, _testing: { seen } };
