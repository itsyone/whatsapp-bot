const fs = require('fs').promises;
const settings = require('../settings');
const config = require('../config');
const { getBotDataPath } = require('./botDataPath');
const { resolveRegisteredJid } = require('./registrationStore');
const { getPersistentValue, setPersistentValue, isMongoConnected } = require('./mongoStore');

const LEGACY_SUDO_PATH = getBotDataPath('userGroupData.json');
const SUDO_CACHE_TTL_MS = 30 * 1000;
const SUDO_STORE_KEY = 'sudo_store_v2';
const ULTIMATE_OWNER_STORE_KEY = 'ultimate_owner_store_v1';

let sudoStoreCache = null;
let sudoStoreCacheAt = 0;
let legacySudoCache = null;
let legacySudoCacheAt = 0;
let ultimateOwnerCache = null;
let ultimateOwnerCacheAt = 0;

function normalizePhone(value) {
    return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function normalizeJid(value) {
    const phone = normalizePhone(value);
    return phone ? `${phone}@s.whatsapp.net` : '';
}

function resolveComparableJid(value) {
    const direct = String(value || '').trim();
    if (!direct) return '';
    const canonical = resolveRegisteredJid([direct]);
    if (canonical) return canonical; // FIXED: canonical sudo identity resolution
    return direct.includes('@') ? direct : normalizeJid(direct);
}

function matchesIdentity(left, right) {
    const leftCanonical = resolveComparableJid(left);
    const rightCanonical = resolveComparableJid(right);
    if (!leftCanonical || !rightCanonical) return false;
    if (leftCanonical === rightCanonical) return true;
    return normalizePhone(leftCanonical) === normalizePhone(rightCanonical); // FIXED: phone fallback identity match
}

async function ensureSudoStore() {
    const now = Date.now();
    if (sudoStoreCache && (now - sudoStoreCacheAt) < SUDO_CACHE_TTL_MS) {
        return sudoStoreCache; // FIXED: cached sudo store reads on hot path
    }

    try {
        const parsed = await getPersistentValue(SUDO_STORE_KEY, null);
        if (!Array.isArray(parsed.sudos)) {
            throw new Error('Invalid sudo store');
        }
        sudoStoreCache = parsed;
        sudoStoreCacheAt = now;
        return parsed;
    } catch (error) {
        if (error.code && error.code !== 'ENOENT') {
            console.error('[permissionHandler] Failed to read sudo store:', error);
        }
        if (!isMongoConnected()) {
            const fallbackState = { sudos: [] };
            sudoStoreCache = fallbackState;
            sudoStoreCacheAt = now;
            return fallbackState; // FIXED: avoid overwriting saved sudo list before Mongo is ready
        }
        const initialState = { sudos: [] };
        await setPersistentValue(SUDO_STORE_KEY, initialState); // FIXED: sudo store auto-init in MongoDB
        sudoStoreCache = initialState;
        sudoStoreCacheAt = now;
        return initialState;
    }
}

async function getLegacySudoList() {
    const now = Date.now();
    if (Array.isArray(legacySudoCache) && (now - legacySudoCacheAt) < SUDO_CACHE_TTL_MS) {
        return legacySudoCache; // FIXED: cached legacy sudo reads on hot path
    }

    try {
        const raw = await fs.readFile(LEGACY_SUDO_PATH, 'utf8');
        const parsed = JSON.parse(raw || '{}');
        legacySudoCache = Array.isArray(parsed?.sudo) ? parsed.sudo.map((entry) => String(entry || '').trim()).filter(Boolean) : []; // FIXED: preserve legacy sudo JIDs
        legacySudoCacheAt = now;
        return legacySudoCache;
    } catch {
        legacySudoCache = [];
        legacySudoCacheAt = now;
        return [];
    }
}

async function writeSudoStore(data) {
    await setPersistentValue(SUDO_STORE_KEY, data);
    sudoStoreCache = data;
    sudoStoreCacheAt = Date.now(); // FIXED: keep sudo cache warm after writes
}

async function ensureUltimateOwnerStore() {
    const now = Date.now();
    if (ultimateOwnerCache && (now - ultimateOwnerCacheAt) < SUDO_CACHE_TTL_MS) {
        return ultimateOwnerCache; // FIXED: cached ultimate-owner reads on hot path
    }

    try {
        const parsed = await getPersistentValue(ULTIMATE_OWNER_STORE_KEY, null);
        if (!Array.isArray(parsed.owners)) {
            throw new Error('Invalid ultimate owner store');
        }
        ultimateOwnerCache = parsed;
        ultimateOwnerCacheAt = now;
        return parsed;
    } catch (error) {
        if (error.code && error.code !== 'ENOENT') {
            console.error('[permissionHandler] Failed to read ultimate owner store:', error);
        }
        if (!isMongoConnected()) {
            const fallbackState = { owners: [] };
            ultimateOwnerCache = fallbackState;
            ultimateOwnerCacheAt = now;
            return fallbackState; // FIXED: avoid overwriting saved ultimate-owner list before Mongo is ready
        }
        const initialState = { owners: [] };
        await setPersistentValue(ULTIMATE_OWNER_STORE_KEY, initialState);
        ultimateOwnerCache = initialState;
        ultimateOwnerCacheAt = now;
        return initialState; // FIXED: ultimate owner store auto-init in MongoDB
    }
}

async function writeUltimateOwnerStore(data) {
    await setPersistentValue(ULTIMATE_OWNER_STORE_KEY, data);
    ultimateOwnerCache = data;
    ultimateOwnerCacheAt = Date.now(); // FIXED: keep ultimate-owner cache warm after writes
}

function getOwnerNumber() {
    const ownerNumber = settings?.ownerNumber || config?.ownerNumber || '';
    return normalizePhone(ownerNumber);
}

async function isOwner(jid) {
    const ownerNumber = getOwnerNumber();
    if (Boolean(ownerNumber) && normalizePhone(jid) === ownerNumber) {
        return true;
    }
    const data = await ensureUltimateOwnerStore();
    return data.owners.some((entry) => matchesIdentity(entry, jid)); // FIXED: central owner check includes ultimate owners
}

async function getSudoList() {
    const data = await ensureSudoStore();
    const current = data.sudos.map((entry) => String(entry || '').trim()).filter(Boolean);
    const legacy = await getLegacySudoList();
    const merged = [];
    for (const entry of [...current, ...legacy]) {
        const comparable = resolveComparableJid(entry);
        if (!comparable) continue;
        const exists = merged.some((item) => matchesIdentity(item, comparable));
        if (!exists) merged.push(comparable);
    }
    return merged; // FIXED: legacy sudo compatibility with raw JID preservation
}

async function isSudo(jid) {
    if (await isOwner(jid)) return true;
    const sudos = await getSudoList();
    return sudos.some((sudoJid) => matchesIdentity(sudoJid, jid)); // FIXED: canonical sudo matching
}

async function isGroupAdmin(jid, groupMetadata) {
    if (await isSudo(jid)) return true;
    const target = normalizePhone(jid);
    const participants = Array.isArray(groupMetadata?.participants) ? groupMetadata.participants : [];
    return participants.some((participant) => {
        const role = participant?.admin;
        return normalizePhone(participant?.id || participant?.jid) === target && (role === 'admin' || role === 'superadmin');
    }); // FIXED: central group admin check
}

async function hasPermission(jid, level, groupMetadata) {
    switch (level) {
        case 'owner':
            return isOwner(jid);
        case 'sudo':
            return isSudo(jid);
        case 'admin':
            return isGroupAdmin(jid, groupMetadata);
        case 'user':
        default:
            return true;
    }
}

async function addSudo(jid) {
    const normalized = resolveComparableJid(jid) || normalizeJid(jid);
    if (!normalized || await isOwner(normalized)) return true;

    const data = await ensureSudoStore();
    const exists = data.sudos.some((entry) => matchesIdentity(entry, normalized));
    if (!exists) {
        data.sudos.push(normalized);
        await writeSudoStore(data); // FIXED: persistent sudo add
    }
    return true;
}

async function removeSudo(jid) {
    const normalized = resolveComparableJid(jid) || normalizeJid(jid);
    const data = await ensureSudoStore();
    data.sudos = data.sudos.filter((entry) => !matchesIdentity(entry, normalized));
    await writeSudoStore(data); // FIXED: persistent sudo remove
    return true;
}

async function addUltimateOwner(jid) {
    const normalized = resolveComparableJid(jid) || normalizeJid(jid);
    if (!normalized) return true;
    const data = await ensureUltimateOwnerStore();
    const exists = data.owners.some((entry) => matchesIdentity(entry, normalized));
    if (!exists) {
        data.owners.push(normalized);
        await writeUltimateOwnerStore(data); // FIXED: persistent ultimate owner add
    }
    return true;
}

async function getUltimateOwnerList() {
    const data = await ensureUltimateOwnerStore();
    return data.owners.map((entry) => String(entry || '').trim()).filter(Boolean);
}

module.exports = {
    isOwner,
    isSudo,
    isGroupAdmin,
    hasPermission,
    addSudo,
    addUltimateOwner,
    removeSudo,
    getSudoList,
    getUltimateOwnerList
};
