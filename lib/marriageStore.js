const { getPersistentValue, setPersistentValue } = require('./mongoStore');
const { resolveRegisteredJid } = require('./registrationStore');

const BONUS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DB_KEY = 'marriages_v2';

let storeCache = null;

async function getStore() {
    if (storeCache) return storeCache;
    storeCache = await getPersistentValue(DB_KEY, { pairs: {}, proposals: {} });
    return storeCache;
}

async function saveStore(store) {
    storeCache = store;
    await setPersistentValue(DB_KEY, store);
}

function normalizeJid(jid) {
    if (!jid) return '';
    const clean = String(jid).trim();
    // Use registrationStore to get canonical ID if possible
    const canonical = resolveRegisteredJid(clean);
    if (canonical) return canonical;
    
    // For non-registered users, strip device index to ensure consistency (e.g. 123:1@s.whatsapp.net -> 123@s.whatsapp.net)
    if (clean.endsWith('@s.whatsapp.net') || clean.endsWith('@c.us') || clean.endsWith('@lid')) {
        const [user, domain] = clean.split('@');
        return `${user.split(':')[0]}@${domain}`;
    }
    return clean;
}

function makePairId(a, b) {
    return [normalizeJid(a), normalizeJid(b)].sort().join('::');
}

async function getProposalByUser(userId) {
    const jid = normalizeJid(userId);
    if (!jid) return null;
    const store = await getStore();
    for (const proposal of Object.values(store.proposals || {})) {
        if (proposal?.from === jid || proposal?.to === jid) return proposal;
    }
    return null;
}

async function createProposal(fromUser, toUser, meta = {}) {
    const from = normalizeJid(fromUser);
    const to = normalizeJid(toUser);
    const store = await getStore();
    const id = makePairId(from, to);
    const proposal = {
        id,
        from,
        to,
        chatId: normalizeJid(meta.chatId),
        createdAt: Date.now()
    };
    store.proposals[id] = proposal;
    await saveStore(store);
    return proposal;
}

async function removeProposalById(proposalId) {
    const id = normalizeJid(proposalId);
    if (!id) return null;
    const store = await getStore();
    const proposal = store.proposals[id] || null;
    if (!proposal) return null;
    delete store.proposals[id];
    await saveStore(store);
    return proposal;
}

async function removeProposalByUser(userId) {
    const proposal = await getProposalByUser(userId);
    if (!proposal) return null;
    return await removeProposalById(proposal.id);
}

async function getMarriageByUser(userId) {
    const jid = normalizeJid(userId);
    if (!jid) return null;
    const store = await getStore();
    for (const pair of Object.values(store.pairs || {})) {
        if (pair?.users?.includes(jid)) return pair;
    }
    return null;
}

async function getAllMarriages() {
    const store = await getStore();
    return Object.values(store.pairs || {})
        .filter((pair) => Array.isArray(pair?.users) && pair.users.length === 2)
        .sort((a, b) => Number(a.marriedAt || 0) - Number(b.marriedAt || 0));
}

async function createMarriage(userA, userB, meta = {}) {
    const a = normalizeJid(userA);
    const b = normalizeJid(userB);
    const store = await getStore();
    const pairId = makePairId(a, b);
    const now = Date.now();
    const pair = {
        id: pairId,
        users: [a, b].sort(),
        chatId: normalizeJid(meta.chatId),
        marriedAt: now,
        lastBonusAt: 0
    };
    store.pairs[pairId] = pair;
    await saveStore(store);
    return pair;
}

async function removeMarriage(userId) {
    const marriage = await getMarriageByUser(userId);
    if (!marriage) return null;
    const store = await getStore();
    delete store.pairs[marriage.id];
    await saveStore(store);
    return marriage;
}

async function markBonusTriggered(pairId, timestamp = Date.now()) {
    const store = await getStore();
    if (!store.pairs[pairId]) return null;
    store.pairs[pairId].lastBonusAt = Number(timestamp || Date.now());
    await saveStore(store);
    return store.pairs[pairId];
}

function canTriggerBonus(pair, now = Date.now()) {
    if (!pair) return false;
    return now - Number(pair.lastBonusAt || 0) >= BONUS_COOLDOWN_MS;
}

module.exports = {
    BONUS_COOLDOWN_MS,
    canTriggerBonus,
    createMarriage,
    createProposal,
    getAllMarriages,
    getMarriageByUser,
    getProposalByUser,
    makePairId,
    markBonusTriggered,
    normalizeJid,
    removeMarriage,
    removeProposalById,
    removeProposalByUser
};
