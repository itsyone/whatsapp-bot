const {
    clone,
    readRegistrationProfiles,
    writeRegistrationProfiles,
    readRegistrationState,
    writeRegistrationState,
    getRawRegistrationProfiles,
    getRawRegistrationState
} = require('./mongoStore');
const { normalizeNetwork } = require('./bankSystem');

const BAG_TIERS = [
    { level: 1, name: 'Basic', icon: '🌱', slots: 5, price: 0, grade: 'R' },
    { level: 2, name: 'Small Bag', icon: '🪝', slots: 10, price: 25000, grade: 'A' },
    { level: 3, name: 'Sailor Pack', icon: '⚓', slots: 15, price: 50000, grade: 'S' },
    { level: 4, name: 'Pirate Bag', icon: '🏴‍☠️', slots: 20, price: 100000, grade: 'SR' },
    { level: 5, name: 'Raider Chest', icon: '🗡', slots: 30, price: 1000000, grade: 'SSR' }
];

function loadRegistrationState() {
    const state = readRegistrationState();
    if (state && state.users && typeof state.users === 'object') {
        return state;
    }

    const migratedUsers = state && typeof state === 'object' && !Array.isArray(state)
        ? Object.fromEntries(
            Object.entries(state).filter(([key, value]) => key !== 'users' && value && typeof value === 'object')
        )
        : {};

    const next = { users: migratedUsers };
    saveRegistrationState(next);
    return next;
}

function saveRegistrationState(state) {
    writeRegistrationState(state);
}

function loadRegistrationProfiles() {
    const raw = readRegistrationProfiles();
    const profiles = raw && raw.users && typeof raw.users === 'object'
        ? {
            ...raw,
            aliases: raw && raw.aliases && typeof raw.aliases === 'object' && !Array.isArray(raw.aliases)
                ? raw.aliases
                : {}
        }
        : {
            users: raw && typeof raw === 'object' && !Array.isArray(raw)
                ? Object.fromEntries(
                    Object.entries(raw).filter(([key, value]) => key !== 'users' && key !== 'aliases' && value && typeof value === 'object')
                )
                : {},
            aliases: {}
        };

    if (!profiles.aliases || typeof profiles.aliases !== 'object' || Array.isArray(profiles.aliases)) {
        profiles.aliases = {};
    }

    return profiles;
}

function saveRegistrationProfiles(profiles) {
    writeRegistrationProfiles(profiles);
}

function normalizeStoredUserId(value) {
    if (!value) return '';
    const jid = String(value).split('@')[0].split(':')[0];
    return jid.replace(/\D/g, '');
}

let lastRawProfiles = null;
let normalizedIdMap = new Map();

function getNormalizedIdMap(users) {
    if (lastRawProfiles === users) return normalizedIdMap;
    
    const nextMap = new Map();
    for (const key of Object.keys(users)) {
        const norm = normalizeStoredUserId(key);
        if (norm) nextMap.set(norm, key);
    }
    
    lastRawProfiles = users;
    normalizedIdMap = nextMap;
    return nextMap;
}

function resolveProfileKey(users, jid, aliases = {}) {
    if (!users || typeof users !== 'object') return null;
    
    // 1. Direct hit (fastest)
    if (jid && users[jid]) return jid;
    
    // 2. Alias hit
    if (jid && aliases && aliases[jid]) {
        const aliased = aliases[jid];
        if (users[aliased]) return aliased;
    }

    // 3. Normalized ID hit (O(1) via Map)
    const normalized = normalizeStoredUserId(jid);
    if (!normalized) return null;

    const map = getNormalizedIdMap(users);
    return map.get(normalized) || null;
}

function getProfileEntry(profiles, jid) {
    const key = resolveProfileKey(profiles?.users, jid, profiles?.aliases);
    if (!key) return { key: null, profile: null };
    
    const rawProfile = profiles.users[key];
    const synced = syncProfileProgression({
        ...rawProfile,
        jid: key,
        userId: rawProfile?.userId || `#${String(key).split('@')[0].split(':')[0].replace(/\D/g, '').slice(-6) || '000001'}`
    });
    
    // If sync changed something, we could save it back, but for now we just return the synced one
    // to keep it fast. If a write happens later, it will be saved.
    return { key, profile: synced };
}

function resolveRegisteredJid(jids) {
    const profiles = getRawRegistrationProfiles();
    const candidates = Array.isArray(jids) ? jids : [jids];

    for (const jid of candidates) {
        const key = resolveProfileKey(profiles?.users, jid, profiles?.aliases);
        if (key) return key;
    }
    return '';
}

function getLinkedRegisteredJids(jids) {
    const profiles = getRawRegistrationProfiles();
    const users = profiles?.users || {};
    const aliases = profiles?.aliases || {};
    const candidates = Array.isArray(jids) ? jids : [jids];
    const canonical = resolveRegisteredJid(candidates);
    const linked = new Set();

    for (const jid of candidates.map((value) => String(value || '').trim()).filter(Boolean)) {
        linked.add(jid);
    }

    if (!canonical) {
        return Array.from(linked);
    }

    linked.add(canonical);
    if (users[canonical]) {
        linked.add(canonical);
    }

    for (const [alias, target] of Object.entries(aliases)) {
        if (target === canonical) {
            linked.add(alias);
        }
    }

    return Array.from(linked);
}

function linkProfileAliases(...jids) {
    const candidates = [...new Set(
        jids
            .flat()
            .map((value) => String(value || '').trim())
            .filter(Boolean)
            .filter((value) => value !== 'status@broadcast' && !value.endsWith('@g.us'))
    )];

    if (candidates.length < 2) return;

    const profiles = loadRegistrationProfiles();
    const users = profiles?.users || {};
    const aliases = profiles?.aliases || {};

    // Find which JID is already registered
    let primaryJid = '';
    for (const jid of candidates) {
        if (users[jid]) {
            primaryJid = jid;
            break;
        }
    }

    if (!primaryJid) return;

    // Link all other JIDs to the primary
    let linkedCount = 0;
    for (const jid of candidates) {
        if (jid !== primaryJid && !aliases[jid]) {
            aliases[jid] = primaryJid;
            linkedCount++;
        }
    }

    if (linkedCount > 0) {
        profiles.aliases = aliases;
        saveRegistrationProfiles(profiles);
    }
}

function getRegisteredProfile(jid) {
    const profiles = getRawRegistrationProfiles();
    return getProfileEntry(profiles, jid).profile;
}

function isRegistered(jid) {
    const profiles = getRawRegistrationProfiles();
    return !!resolveProfileKey(profiles?.users, jid, profiles?.aliases);
}

function resolvePhoneJid(lidJid) {
    if (!lidJid || !lidJid.endsWith('@lid')) return lidJid;
    
    const profiles = getRawRegistrationProfiles();
    const aliases = profiles?.aliases || {};
    
    // Find which phone JID maps to this LID JID
    for (const [alias, canonical] of Object.entries(aliases)) {
        if (canonical === lidJid && alias.endsWith('@s.whatsapp.net')) {
            return alias;
        }
    }
    
    // Also check if there's a direct entry in users with this LID
    // that has a phone JID as an alias
    if (profiles?.users?.[lidJid]) {
        for (const [alias, canonical] of Object.entries(aliases)) {
            if (canonical === lidJid && /\\d+@s\\.whatsapp\\.net$/.test(alias)) {
                return alias;
            }
        }
    }
    
    return lidJid;
}

function getXpTarget(level = 0) {
    const safeLevel = Math.max(0, Number(level || 0));
    return Math.floor(1000 + (safeLevel * 260) + (safeLevel * safeLevel * 45));
}

function normalizeInventory(input = {}) {
    return {
        dropMagnet: Math.max(0, Math.floor(Number(input.dropMagnet || 0))),
        xpBoost: Math.max(0, Math.floor(Number(input.xpBoost || 0))),
        unlockToken: Math.max(0, Math.floor(Number(input.unlockToken || 0))),
        vaultKey: Math.max(0, Math.floor(Number(input.vaultKey || 0))),
        neonAccess: Math.max(0, Math.floor(Number(input.neonAccess || 0))),
        vortexAccess: Math.max(0, Math.floor(Number(input.vortexAccess || 0))),
        titanAccess: Math.max(0, Math.floor(Number(input.titanAccess || 0))),
        glitchAccess: Math.max(0, Math.floor(Number(input.glitchAccess || 0))),
        pistol: Math.max(0, Math.floor(Number(input.pistol || 0))),
        pickaxe: Math.max(0, Math.floor(Number(input.pickaxe || 0))),
        meat: Math.max(0, Math.floor(Number(input.meat || 0))),
        hide: Math.max(0, Math.floor(Number(input.hide || 0))),
        iron: Math.max(0, Math.floor(Number(input.iron || 0))),
        coal: Math.max(0, Math.floor(Number(input.coal || 0))),
        goldOre: Math.max(0, Math.floor(Number(input.goldOre || 0))),
        emerald: Math.max(0, Math.floor(Number(input.emerald || 0))),
        diamond: Math.max(0, Math.floor(Number(input.diamond || 0)))
    };
}

function normalizeBagTier(level) {
    const tier = Math.max(1, Math.floor(Number(level || 1)));
    return BAG_TIERS.find((entry) => entry.level === tier)?.level || 1;
}

function normalizeGender(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'female' ? 'female' : 'male'; // FIXED: stored gender normalization
}

function getBagTierInfo(level = 1) {
    return BAG_TIERS.find((entry) => entry.level === normalizeBagTier(level)) || BAG_TIERS[0];
}

function getNextBagTierInfo(level = 1) {
    const currentLevel = normalizeBagTier(level);
    return BAG_TIERS.find((entry) => entry.level === currentLevel + 1) || null;
}

function countInventorySlotsUsed(inventory = {}) {
    return Object.values(normalizeInventory(inventory)).reduce((sum, value) => {
        return sum + (Math.max(0, Number(value || 0)) > 0 ? 1 : 0);
    }, 0);
}

function accessItemKeyFromNetwork(network) {
    const normalized = normalizeNetwork(network);
    if (!normalized || normalized === 'Wistoria') return '';
    return `${normalized.charAt(0).toLowerCase()}${normalized.slice(1)}Access`;
}

function normalizeEffects(input = {}, now = Date.now()) {
    return {
        dropMagnetReady: Boolean(input.dropMagnetReady),
        xpBoostUntil: Math.max(0, Number(input.xpBoostUntil || 0)),
        tempUnlockedNetworks: Object.fromEntries(
            Object.entries(input.tempUnlockedNetworks || {})
                .map(([network, until]) => [normalizeNetwork(network), Math.max(0, Number(until || 0))])
                .filter(([network, until]) => Boolean(network) && until > now)
        )
    };
}

function getUnlockedNetworks(profile = {}, now = Date.now()) {
    const permanent = Array.isArray(profile.unlockedNetworks)
        ? profile.unlockedNetworks.map((network) => normalizeNetwork(network)).filter(Boolean)
        : [];
    const temp = Object.entries(profile.effects?.tempUnlockedNetworks || {})
        .filter(([, until]) => Number(until || 0) > now)
        .map(([network]) => normalizeNetwork(network))
        .filter(Boolean);
    return [...new Set([...permanent, ...temp])];
}

function resolveCard(profile = {}) {
    if (profile.blackCardUnlocked || String(profile.card || '').toLowerCase() === 'black') {
        return 'black';
    }
    const level = Math.max(0, Number(profile.level || 0));
    if (level >= 10) return 'gold';
    if (level >= 5) return 'silver';
    return 'starter';
}

function syncProfileProgression(profile = {}) {
    const now = Date.now();
    const unlockedNetworks = Array.isArray(profile.unlockedNetworks)
        ? profile.unlockedNetworks.map((network) => normalizeNetwork(network)).filter(Boolean)
        : [];
    const next = {
        ...profile,
        level: Math.max(0, Number(profile.level || 0)),
        xp: Math.max(0, Number(profile.xp || 0)),
        totalXpEarned: Math.max(0, Number(profile.totalXpEarned || 0)),
        gender: normalizeGender(profile.gender), // FIXED: default profile gender
        blackCardUnlocked: Boolean(profile.blackCardUnlocked),
        unlockedNetworks: [...new Set(unlockedNetworks)],
        glitchFragments: Math.max(0, Math.floor(Number(profile.glitchFragments || 0))),
        dropBoostUntil: Math.max(0, Number(profile.dropBoostUntil || 0)),
        bagTier: normalizeBagTier(profile.bagTier),
        inventory: normalizeInventory(profile.inventory),
        effects: normalizeEffects(profile.effects, now)
    };
    next.card = resolveCard(next);
    return next;
}

function upsertRegisteredProfile(jid, data) {
    const profiles = loadRegistrationProfiles();
    const digits = String(jid).split('@')[0].replace(/\D/g, '');
    const { key: existingKey, profile: existingProfile } = getProfileEntry(profiles, jid);
    const existing = syncProfileProgression(existingProfile || {});
    const age = Math.max(5, Math.min(100, Math.floor(Number(data.age || 0))));
    const profile = syncProfileProgression({
        jid,
        name: String(data.name || 'USER').trim(),
        dob: data.dob || '',
        bio: String(data.bio || '').trim(),
        age,
        gender: normalizeGender(data.gender || existing.gender), // FIXED: persist registration gender
        renameChangedAt: Number(existing.renameChangedAt || 0),
        bioUpdatedAt: Number(existing.bioUpdatedAt || 0),
        ageUpdatedAt: Number(existing.ageUpdatedAt || 0),
        userId: `#${digits.slice(-6) || '000001'}`,
        network: 'Wistoria',
        status: 'active',
        level: Number(existing.level || 0),
        xp: Number(existing.xp || 0),
        totalXpEarned: Number(existing.totalXpEarned || 0),
        blackCardUnlocked: Boolean(existing.blackCardUnlocked),
        unlockedNetworks: Array.isArray(existing.unlockedNetworks) ? existing.unlockedNetworks : [],
        glitchFragments: Number(existing.glitchFragments || 0),
        dropBoostUntil: Number(existing.dropBoostUntil || 0),
        bagTier: normalizeBagTier(existing.bagTier),
        inventory: normalizeInventory(existing.inventory),
        effects: normalizeEffects(existing.effects)
    });
    if (existingKey && existingKey !== jid) {
        delete profiles.users[existingKey];
    }
    profiles.users[jid] = profile;
    saveRegistrationProfiles(profiles);
    return profile;
}

function awardRegistrationProgress(jid, amount) {
    const gain = Math.max(0, Math.floor(Number(amount || 0)));
    if (!gain) return null;

    const profiles = loadRegistrationProfiles();
    const { key, profile } = getProfileEntry(profiles, jid);
    if (!profile) return null;

    profile.level = Math.max(0, Number(profile.level || 0));
    profile.xp = Math.max(0, Number(profile.xp || 0));
    profile.totalXpEarned = Math.max(0, Number(profile.totalXpEarned || 0)) + gain;
    profile.xp += gain;

    while (profile.xp >= getXpTarget(profile.level)) {
        profile.xp -= getXpTarget(profile.level);
        profile.level += 1;
    }

    const synced = syncProfileProgression(profile);
    profiles.users[key || jid] = synced;
    saveRegistrationProfiles(profiles);
    return {
        level: synced.level,
        xp: synced.xp,
        xpTarget: getXpTarget(synced.level),
        totalXpEarned: synced.totalXpEarned,
        card: synced.card
    };
}

function setRegisteredNetwork(jid, network) {
    const profiles = loadRegistrationProfiles();
    const { key, profile } = getProfileEntry(profiles, jid);
    if (!profile) return null;
    profile.network = String(network || 'Wistoria');
    profiles.users[key || jid] = syncProfileProgression(profile);
    saveRegistrationProfiles(profiles);
    return profiles.users[key || jid];
}

function grantNetworkUnlock(jid, network) {
    const normalized = normalizeNetwork(network);
    if (!normalized) return null;

    const profiles = loadRegistrationProfiles();
    const { key, profile } = getProfileEntry(profiles, jid);
    if (!profile) return null;

    const synced = syncProfileProgression(profile);
    synced.unlockedNetworks = [...new Set([...(synced.unlockedNetworks || []), normalized])];
    if (normalized === 'Glitch') {
        synced.blackCardUnlocked = true;
    }

    profiles.users[key || jid] = syncProfileProgression(synced);
    saveRegistrationProfiles(profiles);
    return profiles.users[key || jid];
}

function addGlitchFragments(jid, amount = 1) {
    const gain = Math.max(0, Math.floor(Number(amount || 0)));
    if (!gain) return null;

    const profiles = loadRegistrationProfiles();
    const { key, profile } = getProfileEntry(profiles, jid);
    if (!profile) return null;

    profile.glitchFragments = Math.max(0, Math.floor(Number(profile.glitchFragments || 0))) + gain;
    profiles.users[key || jid] = syncProfileProgression(profile);
    saveRegistrationProfiles(profiles);
    return profiles.users[key || jid];
}

function setDropBoost(jid, durationMs = 0) {
    const duration = Math.max(0, Number(durationMs || 0));
    const profiles = loadRegistrationProfiles();
    const { key, profile } = getProfileEntry(profiles, jid);
    if (!profile) return null;

    const now = Date.now();
    const current = Math.max(now, Number(profile.dropBoostUntil || 0));
    profile.dropBoostUntil = duration > 0 ? current + duration : 0;
    profiles.users[key || jid] = syncProfileProgression(profile);
    saveRegistrationProfiles(profiles);
    return profiles.users[key || jid];
}

function addInventoryItem(jid, itemKey, amount = 1) {
    const gain = Math.max(0, Math.floor(Number(amount || 0)));
    if (!gain) return null;

    const profiles = loadRegistrationProfiles();
    const { key, profile } = getProfileEntry(profiles, jid);
    if (!profile) return null;

    const synced = syncProfileProgression(profile);
    const inventory = normalizeInventory(synced.inventory);
    if (!Object.prototype.hasOwnProperty.call(inventory, itemKey)) return null;
    inventory[itemKey] += gain;
    synced.inventory = inventory;
    profiles.users[key || jid] = syncProfileProgression(synced);
    saveRegistrationProfiles(profiles);
    return profiles.users[key || jid];
}

function consumeInventoryItem(jid, itemKey, amount = 1) {
    const cost = Math.max(0, Math.floor(Number(amount || 0)));
    if (!cost) return null;

    const profiles = loadRegistrationProfiles();
    const { key, profile } = getProfileEntry(profiles, jid);
    if (!profile) return null;

    const synced = syncProfileProgression(profile);
    const inventory = normalizeInventory(synced.inventory);
    if (!Object.prototype.hasOwnProperty.call(inventory, itemKey)) return null;
    if (inventory[itemKey] < cost) return { ok: false, profile: synced };
    inventory[itemKey] -= cost;
    synced.inventory = inventory;
    profiles.users[key || jid] = syncProfileProgression(synced);
    saveRegistrationProfiles(profiles);
    return { ok: true, profile: profiles.users[key || jid] };
}

function setBagTier(jid, bagTier) {
    const profiles = loadRegistrationProfiles();
    const { key, profile } = getProfileEntry(profiles, jid);
    if (!profile) return null;
    profile.bagTier = normalizeBagTier(bagTier);
    profiles.users[key || jid] = syncProfileProgression(profile);
    saveRegistrationProfiles(profiles);
    return profiles.users[key || jid];
}

function activateDropMagnet(jid) {
    const profiles = loadRegistrationProfiles();
    const { key, profile } = getProfileEntry(profiles, jid);
    if (!profile) return null;

    const synced = syncProfileProgression(profile);
    synced.effects = normalizeEffects({ ...synced.effects, dropMagnetReady: true });
    profiles.users[key || jid] = syncProfileProgression(synced);
    saveRegistrationProfiles(profiles);
    return profiles.users[key || jid];
}

function consumeDropMagnet(jid) {
    const profiles = loadRegistrationProfiles();
    const { key, profile } = getProfileEntry(profiles, jid);
    if (!profile) return false;

    const synced = syncProfileProgression(profile);
    if (!synced.effects?.dropMagnetReady) return false;
    synced.effects = normalizeEffects({ ...synced.effects, dropMagnetReady: false });
    profiles.users[key || jid] = syncProfileProgression(synced);
    saveRegistrationProfiles(profiles);
    return true;
}

function activateXpBoost(jid, durationMs = 10 * 60 * 1000) {
    const duration = Math.max(0, Number(durationMs || 0));
    const profiles = loadRegistrationProfiles();
    const { key, profile } = getProfileEntry(profiles, jid);
    if (!profile) return null;

    const now = Date.now();
    const synced = syncProfileProgression(profile);
    const current = Math.max(now, Number(synced.effects?.xpBoostUntil || 0));
    synced.effects = normalizeEffects({
        ...synced.effects,
        xpBoostUntil: current + duration
    });
    profiles.users[key || jid] = syncProfileProgression(synced);
    saveRegistrationProfiles(profiles);
    return profiles.users[key || jid];
}

function grantTempNetworkUnlock(jid, network, durationMs = 30 * 60 * 1000) {
    const normalized = normalizeNetwork(network);
    if (!normalized) return null;

    const profiles = loadRegistrationProfiles();
    const { key, profile } = getProfileEntry(profiles, jid);
    if (!profile) return null;

    const now = Date.now();
    const synced = syncProfileProgression(profile);
    const tempUnlockedNetworks = { ...(synced.effects?.tempUnlockedNetworks || {}) };
    tempUnlockedNetworks[normalized] = Math.max(now, Number(tempUnlockedNetworks[normalized] || 0)) + Math.max(0, Number(durationMs || 0));
    synced.effects = normalizeEffects({
        ...synced.effects,
        tempUnlockedNetworks
    });
    profiles.users[key || jid] = syncProfileProgression(synced);
    saveRegistrationProfiles(profiles);
    return profiles.users[key || jid];
}

function updateRegisteredProfile(jid, patch = {}) {
    const profiles = loadRegistrationProfiles();
    const { key, profile } = getProfileEntry(profiles, jid);
    if (!profile) return null;

    const next = syncProfileProgression(profile);
    const now = Date.now();

    if (typeof patch.name === 'string') {
        const name = String(patch.name).replace(/\s+/g, ' ').trim().slice(0, 30);
        if (name) {
            next.name = name;
            next.renameChangedAt = Number(patch.renameChangedAt || now);
        }
    }

    if (typeof patch.bio === 'string') {
        next.bio = String(patch.bio).replace(/\s+/g, ' ').trim().slice(0, 120);
        next.bioUpdatedAt = Number(patch.bioUpdatedAt || now);
    }

    if (patch.age !== undefined) {
        const age = Math.max(5, Math.min(100, Math.floor(Number(patch.age || 0))));
        if (age) {
            next.age = age;
            next.ageUpdatedAt = Number(patch.ageUpdatedAt || now);
        }
    }

    if (patch.gender !== undefined) {
        next.gender = normalizeGender(patch.gender); // FIXED: editable profile gender
    }

    profiles.users[key || jid] = syncProfileProgression(next);
    saveRegistrationProfiles(profiles);
    return profiles.users[key || jid];
}

module.exports = {
    loadRegistrationState,
    saveRegistrationState,
    loadRegistrationProfiles,
    saveRegistrationProfiles,
    getRegisteredProfile,
    resolveRegisteredJid,
    getLinkedRegisteredJids,
    linkProfileAliases,
    isRegistered,
    getXpTarget,
    resolveCard,
    syncProfileProgression,
    upsertRegisteredProfile,
    awardRegistrationProgress,
    setRegisteredNetwork,
    grantNetworkUnlock,
    accessItemKeyFromNetwork,
    addGlitchFragments,
    setDropBoost,
    getUnlockedNetworks,
    addInventoryItem,
    consumeInventoryItem,
    countInventorySlotsUsed,
    getBagTierInfo,
    getNextBagTierInfo,
    setBagTier,
    activateDropMagnet,
    consumeDropMagnet,
    activateXpBoost,
    grantTempNetworkUnlock,
    getRawRegistrationProfiles,
    updateRegisteredProfile
};
