const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', 'data', 'card_claims.json');

function readStore() {
    try {
        if (!fs.existsSync(STORE_PATH)) {
            return { spawns: {}, users: {} };
        }
        const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
        if (!data || typeof data !== 'object') return { spawns: {}, users: {} };
        if (!data.spawns || typeof data.spawns !== 'object') data.spawns = {};
        if (!data.users || typeof data.users !== 'object') data.users = {};
        return data;
    } catch {
        return { spawns: {}, users: {} };
    }
}

function writeStore(store) {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function prune(store) {
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000;
    const keys = Object.keys(store.spawns);
    for (const key of keys) {
        const s = store.spawns[key];
        if (!s || !s.createdAt || now - s.createdAt > maxAge) {
            delete store.spawns[key];
        }
    }
}

function generateClaimId(length = 5) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i += 1) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

function createSpawn(card, chatId, customId = null) {
    const store = readStore();
    prune(store);

    let claimId = customId ? String(customId).toLowerCase() : generateClaimId(5);
    while (store.spawns[claimId]) {
        if (customId) {
            // If custom ID exists, append a random char to make it unique
            claimId += generateClaimId(1);
        } else {
            claimId = generateClaimId(5);
        }
    }

    store.spawns[claimId] = {
        id: claimId,
        chatId,
        createdAt: Date.now(),
        card
    };
    writeStore(store);
    return claimId;
}


function claimCard(claimId, userJid) {
    const store = readStore();
    prune(store);

    const id = String(claimId || '').toLowerCase().trim();
    const spawn = store.spawns[id];
    if (!spawn) {
        return { ok: false, reason: 'invalid' };
    }

    const user = String(userJid || '').trim();
    if (!store.users[user]) {
        store.users[user] = {
            savedCount: 0,
            cards: []
        };
    }

    const entry = {
        claimId: id,
        claimedAt: Date.now(),
        ...spawn.card
    };

    store.users[user].cards.push(entry);
    store.users[user].savedCount += 1;

    delete store.spawns[id];
    writeStore(store);

    return {
        ok: true,
        card: spawn.card,
        savedCount: store.users[user].savedCount
    };
}

function getUserData(userJid) {
    const store = readStore();
    const user = String(userJid || '').trim();
    const data = store.users[user] || { savedCount: 0, cards: [] };
    return {
        savedCount: data.savedCount || 0,
        cards: Array.isArray(data.cards) ? data.cards : []
    };
}

function removeUserCard(userJid, query = '') {
    const store = readStore();
    const user = String(userJid || '').trim();
    if (!store.users[user] || !Array.isArray(store.users[user].cards) || !store.users[user].cards.length) {
        return { ok: false, reason: 'empty' };
    }

    const cards = store.users[user].cards;
    let idx = -1;
    const q = String(query || '').trim().toLowerCase();

    if (!q) {
        idx = cards.length - 1;
    } else {
        idx = cards.findIndex((c) => String(c.claimId || '').toLowerCase() === q);
        if (idx < 0) idx = cards.findIndex((c) => String(c.cardNo || '').toLowerCase() === q);
        if (idx < 0) idx = cards.findIndex((c) => String(c.cardName || '').toLowerCase().includes(q));
    }

    if (idx < 0) return { ok: false, reason: 'not_found' };

    const [card] = cards.splice(idx, 1);
    store.users[user].savedCount = Math.max(0, cards.length);
    writeStore(store);

    return {
        ok: true,
        card,
        savedCount: store.users[user].savedCount
    };
}

function getRandomUserCard(userJid) {
    const data = getUserData(userJid);
    if (!data.cards.length) return null;
    return data.cards[Math.floor(Math.random() * data.cards.length)];
}

function getCardOwners(name, tier) {
    const store = readStore();
    const owners = [];
    const searchName = String(name || '').toLowerCase().trim();
    const searchTier = String(tier || '').toUpperCase().trim();

    for (const [jid, data] of Object.entries(store.users)) {
        if (!data || !Array.isArray(data.cards)) continue;
        const count = data.cards.filter(c => 
            String(c.cardName || c.name || '').toLowerCase().trim() === searchName &&
            String(c.tier || '').toUpperCase().trim() === searchTier
        ).length;
        
        if (count > 0) {
            owners.push({ jid, count });
        }
    }
    return owners;
}

module.exports = {
    createSpawn,
    claimCard,
    generateClaimId,
    getUserData,
    removeUserCard,
    getRandomUserCard,
    getCardOwners
};

