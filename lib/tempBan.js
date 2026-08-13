const fs = require('fs');
const path = require('path');

const TEMP_BAN_PATH = path.join(process.cwd(), 'data', 'tempBans.json');
let tempBanCache = null;
let lastLoadAt = 0;
const LOAD_INTERVAL = 300_000;

function ensureStore() {
    if (tempBanCache && Date.now() - lastLoadAt < LOAD_INTERVAL) return tempBanCache;
    
    if (!fs.existsSync(TEMP_BAN_PATH)) {
        fs.mkdirSync(path.dirname(TEMP_BAN_PATH), { recursive: true });
        const initial = { users: {} };
        fs.writeFileSync(TEMP_BAN_PATH, JSON.stringify(initial, null, 2), 'utf8');
        tempBanCache = initial;
        lastLoadAt = Date.now();
        return initial;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(TEMP_BAN_PATH, 'utf8'));
        if (!parsed.users || typeof parsed.users !== 'object') {
            parsed.users = {};
        }
        tempBanCache = parsed;
        lastLoadAt = Date.now();
        return parsed;
    } catch {
        const fallback = { users: {} };
        tempBanCache = fallback;
        return fallback;
    }
}

function saveStore(store) {
    tempBanCache = store;
    fs.writeFileSync(TEMP_BAN_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function cleanupExpired(store = ensureStore(), now = Date.now()) {
    let changed = false;

    for (const [jid, entry] of Object.entries(store.users || {})) {
        if (!entry || Number(entry.until || 0) <= now) {
            delete store.users[jid];
            changed = true;
        }
    }

    if (changed) saveStore(store);
    return store;
}

function getTempBan(userId) {
    const store = cleanupExpired();
    const entry = store.users?.[userId];
    if (!entry) return null;
    return {
        until: Number(entry.until || 0),
        reason: String(entry.reason || 'temporary restriction')
    };
}

function setTempBan(userId, durationMs, reason = 'temporary restriction') {
    if (!userId) return null;
    const store = cleanupExpired();
    store.users[userId] = {
        until: Date.now() + Math.max(1000, Number(durationMs || 0)),
        reason: String(reason || 'temporary restriction')
    };
    saveStore(store);
    return store.users[userId];
}

function clearAllTempBans() {
    const store = { users: {} };
    saveStore(store);
    return store;
}

module.exports = {
    getTempBan,
    setTempBan,
    clearAllTempBans
};
