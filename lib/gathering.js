const fs = require('fs');
const path = require('path');
const { getRegisteredProfile, addInventoryItem, consumeInventoryItem } = require('./registrationStore');

const COOLDOWN_PATH = path.join(__dirname, '..', 'data', 'gatheringCooldowns.json');

const ITEM_INFO = {
    pistol: { label: 'Pistol', emoji: '🔫', sellPrice: 0, aliases: ['pistol', 'gun'] },
    pickaxe: { label: 'Pickaxe', emoji: '⛏', sellPrice: 0, aliases: ['pickaxe'] },
    meat: { label: 'Meat', emoji: '🍖', sellPrice: 10, aliases: ['meat'] },
    hide: { label: 'Hide', emoji: '🧥', sellPrice: 15, aliases: ['hide'] },
    iron: { label: 'Iron', emoji: '🪨', sellPrice: 18, aliases: ['iron'] },
    coal: { label: 'Coal', emoji: '⚫', sellPrice: 12, aliases: ['coal', 'charcoal'] },
    goldOre: { label: 'Gold', emoji: '🪙', sellPrice: 60, aliases: ['gold', 'goldore', 'gold-ore'] },
    emerald: { label: 'Emerald', emoji: '💚', sellPrice: 140, aliases: ['emerald'] },
    diamond: { label: 'Diamond', emoji: '💎', sellPrice: 220, aliases: ['diamond'] }
};

function ensureStore() {
    if (!fs.existsSync(path.dirname(COOLDOWN_PATH))) {
        fs.mkdirSync(path.dirname(COOLDOWN_PATH), { recursive: true });
    }
    if (!fs.existsSync(COOLDOWN_PATH)) {
        fs.writeFileSync(COOLDOWN_PATH, JSON.stringify({ users: {} }, null, 2), 'utf8');
    }
}

function readStore() {
    ensureStore();
    try {
        const parsed = JSON.parse(fs.readFileSync(COOLDOWN_PATH, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return { users: {} };
        if (!parsed.users || typeof parsed.users !== 'object') parsed.users = {};
        return parsed;
    } catch {
        return { users: {} };
    }
}

function writeStore(store) {
    ensureStore();
    fs.writeFileSync(COOLDOWN_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function getCooldown(userId, action) {
    const store = readStore();
    return Number(store.users?.[userId]?.[action] || 0);
}

function setCooldown(userId, action, timestamp) {
    const store = readStore();
    if (!store.users[userId]) store.users[userId] = {};
    store.users[userId][action] = Number(timestamp || 0);
    writeStore(store);
}

function getRemainingCooldown(userId, action, durationMs) {
    const last = getCooldown(userId, action);
    const remaining = last + durationMs - Date.now();
    return Math.max(0, remaining);
}

function formatCooldown(ms) {
    const totalSeconds = Math.max(1, Math.ceil(Number(ms || 0) / 1000));
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    if (!mins) return `${secs}s`;
    return secs ? `${mins}m ${secs}s` : `${mins}m`;
}

function getItemInfo(key) {
    return ITEM_INFO[key] || null;
}

function findItemKey(input) {
    const normalized = String(input || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!normalized) return '';
    for (const [key, info] of Object.entries(ITEM_INFO)) {
        if (info.aliases.some((alias) => alias.replace(/[^a-z]/g, '') === normalized)) return key;
    }
    return '';
}

function parseSellTarget(rawText = '') {
    const parts = String(rawText || '').trim().split(/\s+/).slice(1);
    if (!parts.length) return { itemKey: '', amount: 0 };

    let amount = 0;
    const nameParts = [];
    for (const part of parts) {
        if (/^\d+$/.test(part)) {
            amount = Math.max(0, Math.floor(Number(part)));
        } else if (String(part).toLowerCase() === 'all') {
            continue; // FIXED: sell-all parser
        } else {
            nameParts.push(part);
        }
    }

    const itemKey = findItemKey(nameParts.join(' '));
    return { itemKey, amount: amount || 1 };
}

function getItemAmount(profile, itemKey) {
    return Math.max(0, Number(profile?.inventory?.[itemKey] || 0));
}

function canAffordItemSlot(jid, itemKey, amount = 1) {
    const profile = getRegisteredProfile(jid);
    if (!profile) return false;
    const current = Math.max(0, Number(profile.inventory?.[itemKey] || 0));
    if (current > 0) return true;
    const totalItems = Object.values(profile.inventory || {}).reduce((sum, value) => {
        return sum + (Math.max(0, Number(value || 0)) > 0 ? 1 : 0);
    }, 0);
    const bagSlots = Number(profile?.bagTier ? require('./registrationStore').getBagTierInfo(profile.bagTier).slots : 5);
    return totalItems + amount <= bagSlots;
}

module.exports = {
    ITEM_INFO,
    addInventoryItem,
    consumeInventoryItem,
    findItemKey,
    formatCooldown,
    getCooldown,
    getItemAmount,
    getItemInfo,
    getRegisteredProfile,
    getRemainingCooldown,
    parseSellTarget,
    setCooldown
};
