const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const { getBotId, getBotDataPath } = require('./botDataPath');
dotenv.config({ path: path.join(process.cwd(), 'env') });

const { clone, readJsonSafe, writeJsonSafe } = require('../utils/jsonStore');

const MONGODB_URI = String(process.env.MONGO_URI || '').trim();
const MONGO_CONNECT_OPTIONS = {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 30000,
    maxPoolSize: 10,
    minPoolSize: 1,
    family: 4
};
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;
const REGISTRATION_SCOPE = '__shared__';
const SHARED_DATA_DIR = path.join(process.cwd(), 'data');
const SHARED_PROFILES_FILE = path.join(SHARED_DATA_DIR, 'registrationProfiles.json');
const SHARED_STATES_FILE = path.join(SHARED_DATA_DIR, 'registrationStates.json');
const ENABLE_ECONOMY_JSON_MIRROR = String(process.env.ENABLE_ECONOMY_JSON_MIRROR || '').trim() === '1';
const ENABLE_JSON_MIRRORS = String(process.env.ENABLE_JSON_MIRRORS || '').trim() === '1';

const StorageMetaSchema = new mongoose.Schema({
    key: { type: String, unique: true, required: true },
    value: { type: String, required: true }
});
const StorageMeta = mongoose.models.StorageMeta || mongoose.model('StorageMeta', StorageMetaSchema);

const RegistrationProfileSchema = new mongoose.Schema({
    bot_id: { type: String, required: true, index: true },
    canonical_jid: { type: String, required: true },
    payload: { type: String, required: true },
    updated_at: { type: Number, required: true }
});
const RegistrationProfile = mongoose.models.RegistrationProfile || mongoose.model('RegistrationProfile', RegistrationProfileSchema);

const RegistrationAliasSchema = new mongoose.Schema({
    bot_id: { type: String, required: true, index: true },
    alias_jid: { type: String, required: true },
    canonical_jid: { type: String, required: true }
});
const RegistrationAlias = mongoose.models.RegistrationAlias || mongoose.model('RegistrationAlias', RegistrationAliasSchema);

const RegistrationStateSchema = new mongoose.Schema({
    bot_id: { type: String, required: true, index: true },
    jid: { type: String, required: true },
    payload: { type: String, required: true },
    updated_at: { type: Number, required: true }
});
const RegistrationState = mongoose.models.RegistrationState || mongoose.model('RegistrationState', RegistrationStateSchema);

const ChatbotMemorySchema = new mongoose.Schema({
    bot_id: { type: String, required: true, index: true },
    user_id: { type: String, required: true },
    payload: { type: String, required: true },
    updated_at: { type: Number, required: true }
});
RegistrationProfileSchema.index({ bot_id: 1, canonical_jid: 1 }, { unique: true });
RegistrationAliasSchema.index({ bot_id: 1, alias_jid: 1 }, { unique: true });
RegistrationStateSchema.index({ bot_id: 1, jid: 1 }, { unique: true });
ChatbotMemorySchema.index({ bot_id: 1, user_id: 1 }, { unique: true });
const ChatbotMemory = mongoose.models.ChatbotMemory || mongoose.model('ChatbotMemory', ChatbotMemorySchema);

const EconomyDataSchema = new mongoose.Schema({
    bot_id: { type: String, required: true, index: true },
    payload: { type: String, required: true },
    updated_at: { type: Number, required: true }
});
const EconomyData = mongoose.models.EconomyData || mongoose.model('EconomyData', EconomyDataSchema);

const StaffRolesSchema = new mongoose.Schema({
    bot_id: { type: String, required: true, index: true },
    payload: { type: String, required: true },
    updated_at: { type: Number, required: true }
});
const StaffRoles = mongoose.models.StaffRoles || mongoose.model('StaffRoles', StaffRolesSchema);

let memoryCache = {
    profiles: {},
    states: {},
    chatMem: {},
    economy: {},
    staff: {}
};


let mongoEnabled = Boolean(MONGODB_URI);
let mongoConnected = false;
let mongoConnecting = false;
let reconnectTimer = null;
let reconnectDelayMs = RECONNECT_MIN_MS;
const syncedBots = new Set();
const syncPromises = new Map();
const lastSyncStartedAtByBot = new Map();
let lastMongoIssue = { key: '', at: 0 };
const pendingWrites = {
    profiles: {},
    states: {},
    chatMem: {},
    economy: {},
    staff: {},
    persistent: {}
};

let lastMirrorAt = {
    profiles: 0,
    states: 0,
    chatMem: 0,
    economy: 0,
    staff: 0
};

const MIRROR_INTERVAL = 60_000;

function getRegistrationScope() {
    return REGISTRATION_SCOPE;
}

function ensureSharedDataDir() {
    try {
        require('fs').mkdirSync(SHARED_DATA_DIR, { recursive: true });
    } catch {}
}

function shouldUseJsonMirror(kind = 'general') {
    if (!mongoEnabled) return true;
    if (kind === 'economy') return ENABLE_ECONOMY_JSON_MIRROR;
    return ENABLE_JSON_MIRRORS;
}

function logMongoIssue(level, prefix, errorLike) {
    const message = String(errorLike?.message || errorLike || '').trim() || 'unknown mongo error';
    const key = `${prefix}:${message}`;
    const now = Date.now();
    if (lastMongoIssue.key === key && now - lastMongoIssue.at < 60_000) return;
    lastMongoIssue = { key, at: now };
    const line = `${prefix}: ${message}`;
    if (level === 'warn') {
        console.warn(line);
    } else {
        console.error(line);
    }
}

function getScopedProfilesCache(scope = getRegistrationScope()) {
    if (!memoryCache.profiles[scope]) {
        memoryCache.profiles[scope] = { users: {}, aliases: {} };
    }
    return memoryCache.profiles[scope];
}

function getScopedStatesCache(scope = getRegistrationScope()) {
    if (!memoryCache.states[scope]) {
        memoryCache.states[scope] = { users: {} };
    }
    return memoryCache.states[scope];
}

function getScopedChatMemCache(botId = getBotId()) {
    if (!memoryCache.chatMem[botId]) {
        memoryCache.chatMem[botId] = {};
    }
    return memoryCache.chatMem[botId];
}

function readProfilesMirror() {
    if (!shouldUseJsonMirror('profiles')) {
        return { users: {}, aliases: {} };
    }
    ensureSharedDataDir();
    const profilePath = SHARED_PROFILES_FILE;
    const raw = readJsonSafe(profilePath, { users: {}, aliases: {} });
    return {
        users: raw && raw.users && typeof raw.users === 'object' && !Array.isArray(raw.users) ? raw.users : {},
        aliases: raw && raw.aliases && typeof raw.aliases === 'object' && !Array.isArray(raw.aliases) ? raw.aliases : {}
    };
}

function readStatesMirror() {
    if (!shouldUseJsonMirror('states')) {
        return { users: {} };
    }
    ensureSharedDataDir();
    const statePath = SHARED_STATES_FILE;
    const raw = readJsonSafe(statePath, { users: {} });
    return {
        users: raw && raw.users && typeof raw.users === 'object' && !Array.isArray(raw.users) ? raw.users : {}
    };
}

function readChatMemoryMirror(botId = getBotId()) {
    if (!shouldUseJsonMirror('chatMem')) {
        return {};
    }
    const memoryPath = getBotDataPath('memory.json');
    const raw = readJsonSafe(memoryPath, {});
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function readEconomyMirror() {
    if (!shouldUseJsonMirror('economy')) {
        return { users: {}, meta: {} };
    }
    ensureSharedDataDir();
    const economyPath = path.join(SHARED_DATA_DIR, 'economy.json');
    const raw = readJsonSafe(economyPath, {});
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function countEconomyUsers(db) {
    return Object.keys(db?.users || {}).length;
}

function normalizeBankMap(banks = {}) {
    return {
        Wistoria: Math.max(0, Number((banks?.Wistoria ?? banks?.Eclipse) || 0)),
        Neon: Math.max(0, Number(banks?.Neon || 0)),
        Vortex: Math.max(0, Number(banks?.Vortex || 0)),
        Titan: Math.max(0, Number(banks?.Titan || 0)),
        Glitch: Math.max(0, Number(banks?.Glitch || 0))
    };
}

function preserveEconomyBanks(existingDb = {}, nextDb = {}, options = {}) {
    if (options.allowBankShrink === true) return nextDb;

    const next = clone(nextDb || {});
    next.users = next.users && typeof next.users === 'object' && !Array.isArray(next.users)
        ? next.users
        : {};
    const existingUsers = existingDb?.users && typeof existingDb.users === 'object' ? existingDb.users : {};

    for (const [jid, existingUser] of Object.entries(existingUsers)) {
        if (!next.users[jid]) continue;
        const existingBanks = normalizeBankMap(existingUser?.banks || {});
        const nextBanks = normalizeBankMap(next.users[jid]?.banks || {});
        let changed = false;
        for (const network of Object.keys(existingBanks)) {
            if (existingBanks[network] > nextBanks[network]) {
                nextBanks[network] = existingBanks[network];
                changed = true;
            }
        }
        if (changed) {
            next.users[jid] = { ...next.users[jid], banks: nextBanks };
        }
    }

    return next;
}

function readStaffRolesMirror() {
    if (!shouldUseJsonMirror('staff')) {
        return { coOwners: [], mods: [], staff: [] };
    }
    ensureSharedDataDir();
    const staffPath = path.join(SHARED_DATA_DIR, 'staffRoles.json');
    const raw = readJsonSafe(staffPath, { coOwners: [], mods: [], staff: [] });
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { coOwners: [], mods: [], staff: [] };
}


function hasMongoConnection() {
    return mongoEnabled && mongoose.connection.readyState === 1;
}

function scheduleReconnect(reason = 'unknown') {
    if (!mongoEnabled || reconnectTimer) return;
    const waitMs = reconnectDelayMs;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectMongo(`retry:${reason}`).catch(() => null);
    }, waitMs);
    reconnectTimer.unref?.();
    reconnectDelayMs = Math.min(RECONNECT_MAX_MS, waitMs * 2);
    console.warn(`[mongo] reconnect scheduled in ${waitMs}ms (${reason})`);
}

async function flushProfilesToMongo(users, aliases, now = Date.now(), botId = getBotId()) {
    if (!hasMongoConnection()) {
        pendingWrites.profiles[botId] = { users: clone(users || {}), aliases: clone(aliases || {}), now };
        return false;
    }

    try {
        const profileOps = Object.entries(users || {}).map(([jid, profile]) => ({
            updateOne: {
                filter: { bot_id: botId, canonical_jid: jid }, // FIXED: bot_id profile filter
                update: { bot_id: botId, canonical_jid: jid, payload: JSON.stringify(profile || {}), updated_at: now },
                upsert: true
            }
        }));

        if (profileOps.length > 0) {
            await RegistrationProfile.bulkWrite(profileOps);
        }

        const aliasOps = Object.entries(aliases || {}).map(([aliasJid, canonicalJid]) => ({
            updateOne: {
                filter: { bot_id: botId, alias_jid: aliasJid }, // FIXED: bot_id alias filter
                update: { bot_id: botId, alias_jid: aliasJid, canonical_jid: canonicalJid },
                upsert: true
            }
        }));

        if (aliasOps.length > 0) {
            await RegistrationAlias.bulkWrite(aliasOps);
        }

        return true;
    } catch (err) {
        console.error('MongoDB write error (profiles):', err?.message || err);
        pendingWrites.profiles[botId] = { users: clone(users || {}), aliases: clone(aliases || {}), now };
        scheduleReconnect('profiles-write-failed');
        return false;
    }
}

async function flushStatesToMongo(users, now = Date.now(), botId = getBotId()) {
    if (!hasMongoConnection()) {
        pendingWrites.states[botId] = { users: clone(users || {}), now };
        return false;
    }

    try {
        const stateOps = Object.entries(users || {}).map(([jid, payload]) => ({
            updateOne: {
                filter: { bot_id: botId, jid }, // FIXED: bot_id state filter
                update: { bot_id: botId, jid, payload: JSON.stringify(payload || {}), updated_at: now },
                upsert: true
            }
        }));

        if (stateOps.length > 0) {
            await RegistrationState.bulkWrite(stateOps);
        }

        return true;
    } catch (err) {
        console.error('MongoDB write error (states):', err?.message || err);
        pendingWrites.states[botId] = { users: clone(users || {}), now };
        scheduleReconnect('states-write-failed');
        return false;
    }
}

async function flushChatMemoryToMongo(memoryDb, userId = '', now = Date.now(), botId = getBotId()) {
    if (!hasMongoConnection()) {
        pendingWrites.chatMem[botId] = { memoryDb: clone(memoryDb || {}), userId, now };
        return false;
    }

    try {
        if (userId) {
            if (!memoryDb?.[userId]) {
                await ChatbotMemory.deleteOne({ bot_id: botId, user_id: userId });
                return true;
            }

            try {
                const compositeId = `${botId}_${userId}`;
                await ChatbotMemory.updateOne(
                    { user_id: compositeId },
                    { 
                        bot_id: botId, 
                        user_id: compositeId, 
                        payload: JSON.stringify(memoryDb[userId] || {}), 
                        updated_at: Number(memoryDb[userId]?.updatedAt || now) 
                    },
                    { upsert: true }
                );
            } catch (innerErr) {
                if (innerErr.code === 11000) {
                    console.warn(`[mongo] Duplicate key ignored for user ${userId} during updateOne`);
                } else {
                    throw innerErr;
                }
            }
            return true;
        }

        const memOps = Object.entries(memoryDb || {}).map(([k, payload]) => {
            const compositeId = `${botId}_${k}`;
            return {
                updateOne: {
                    filter: { user_id: compositeId },
                    update: { 
                        bot_id: botId, 
                        user_id: compositeId, 
                        payload: JSON.stringify(payload || {}), 
                        updated_at: Number(payload?.updatedAt || now) 
                    },
                    upsert: true
                }
            };
        });

        if (memOps.length > 0) {
            try {
                await ChatbotMemory.bulkWrite(memOps);
            } catch (innerErr) {
                const isDuplicate = innerErr.code === 11000 || (Array.isArray(innerErr.writeErrors) && innerErr.writeErrors.some(e => e.code === 11000));
                if (isDuplicate) {
                    console.warn(`[mongo] Duplicate key ignored during bulkWrite`);
                } else {
                    throw innerErr;
                }
            }
        }

        return true;
    } catch (err) {
        console.error('MongoDB write error (chat memory):', err?.message || err);
        pendingWrites.chatMem[botId] = { memoryDb: clone(memoryDb || {}), userId, now };
        scheduleReconnect('chatmem-write-failed');
        return false;
    }
}

async function flushEconomyToMongo(db, now = Date.now(), botId = getBotId(), options = {}) {
    if (!hasMongoConnection()) {
        pendingWrites.economy[botId] = { db: clone(db || {}), now, options: { ...options } };
        return false;
    }
    try {
        const existingDoc = await EconomyData.findOne({ bot_id: botId }).lean();
        const existingDb = JSON.parse(existingDoc?.payload || '{}');
        const safeDb = preserveEconomyBanks(existingDb, db, options);

        if (options.allowDestructiveShrink !== true) {
            const existingUsers = countEconomyUsers(existingDb);
            const nextUsers = countEconomyUsers(safeDb);
            const isSuspiciousShrink =
                (existingUsers > 0 && nextUsers === 0) ||
                (existingUsers >= 10 && nextUsers + 2 < existingUsers);

            if (isSuspiciousShrink) {
                console.error(
                    `[economy-guard] blocked suspicious shrink for ${botId}: existing=${existingUsers}, next=${nextUsers}`
                );
                pendingWrites.economy[botId] = { db: clone(db || {}), now, options: { ...options } };
                return false;
            }
        }

        await EconomyData.updateOne(
            { bot_id: botId },
            { bot_id: botId, payload: JSON.stringify(safeDb || {}), updated_at: now },
            { upsert: true }
        );
        return true;
    } catch (err) {
        console.error('MongoDB write error (economy):', err?.message || err);
        pendingWrites.economy[botId] = { db: clone(db || {}), now, options: { ...options } };
        scheduleReconnect('economy-write-failed');
        return false;
    }
}

async function flushStaffToMongo(roles, now = Date.now(), botId = getBotId()) {
    if (!hasMongoConnection()) {
        pendingWrites.staff[botId] = { roles: clone(roles || {}), now };
        return false;
    }
    try {
        await StaffRoles.updateOne(
            { bot_id: botId },
            { bot_id: botId, payload: JSON.stringify(roles || {}), updated_at: now },
            { upsert: true }
        );
        return true;
    } catch (err) {
        console.error('MongoDB write error (staff):', err?.message || err);
        pendingWrites.staff[botId] = { roles: clone(roles || {}), now };
        scheduleReconnect('staff-write-failed');
        return false;
    }
}


async function flushPendingWrites() {
    if (!hasMongoConnection()) return;

    for (const [botId, next] of Object.entries(pendingWrites.profiles)) {
        delete pendingWrites.profiles[botId];
        await flushProfilesToMongo(next.users, next.aliases, next.now, botId);
    }

    for (const [botId, next] of Object.entries(pendingWrites.states)) {
        delete pendingWrites.states[botId];
        await flushStatesToMongo(next.users, next.now, botId);
    }

    for (const [botId, next] of Object.entries(pendingWrites.chatMem)) {
        delete pendingWrites.chatMem[botId];
        await flushChatMemoryToMongo(next.memoryDb, next.userId, next.now, botId);
    }

    for (const [botId, next] of Object.entries(pendingWrites.economy)) {
        delete pendingWrites.economy[botId];
        await flushEconomyToMongo(next.db, next.now, botId, next.options || {});
    }

    for (const [botId, next] of Object.entries(pendingWrites.staff)) {
        delete pendingWrites.staff[botId];
        await flushStaffToMongo(next.roles, next.now, botId);
    }

    for (const [key, next] of Object.entries(pendingWrites.persistent)) {
        delete pendingWrites.persistent[key];
        await setPersistentValue(key, next.value); // FIXED: flush queued persistent writes after Mongo reconnect
    }
}


async function connectMongo(reason = 'startup') {
    if (!mongoEnabled) {
        console.warn('[mongo] MONGO_URI missing, using local cache fallback only');
        return false;
    }
    if (hasMongoConnection()) return true;
    if (mongoConnecting) return false;

    mongoConnecting = true;
    try {
        await mongoose.connect(MONGODB_URI, MONGO_CONNECT_OPTIONS);
        mongoConnected = true;
        reconnectDelayMs = RECONNECT_MIN_MS;
        lastMongoIssue = { key: '', at: 0 };
        console.log(`Connected to MongoDB backend (${reason})`);
        await flushPendingWrites();
        return true;
    } catch (err) {
        mongoConnected = false;
        logMongoIssue('error', 'MongoDB connection error', err);
        scheduleReconnect(reason);
        return false;
    } finally {
        mongoConnecting = false;
    }
}

async function syncFromMongo(force = false, botId = getBotId()) {
    if (!mongoEnabled) return false;
    if (!hasMongoConnection()) {
        await connectMongo('sync').catch(() => null);
        if (!hasMongoConnection()) return false;
    }

    const normalizedBotId = String(botId || getBotId() || '').trim().toLowerCase() || getBotId();
    const now = Date.now();
    const lastSyncStartedAt = lastSyncStartedAtByBot.get(normalizedBotId) || 0;
    if (!force && lastSyncStartedAt && now - lastSyncStartedAt < 5_000) {
        return false;
    }
    lastSyncStartedAtByBot.set(normalizedBotId, now);

    try {
        console.log('Syncing from MongoDB into cache...');
        const profileScope = getRegistrationScope();
        const fallbackProfiles = readProfilesMirror();
        const fallbackStates = readStatesMirror();
        const fallbackChatMem = readChatMemoryMirror(normalizedBotId);

        const dbProfiles = await RegistrationProfile.find({ bot_id: profileScope });
        const dbAliases = await RegistrationAlias.find({ bot_id: profileScope });
        const mergedProfiles = {
            users: { ...fallbackProfiles.users },
            aliases: { ...fallbackProfiles.aliases }
        };
        for (const doc of dbProfiles) {
            try {
                mergedProfiles.users[doc.canonical_jid] = JSON.parse(doc.payload || '{}');
            } catch {}
        }
        for (const doc of dbAliases) {
            mergedProfiles.aliases[doc.alias_jid] = doc.canonical_jid;
        }
        memoryCache.profiles[profileScope] = mergedProfiles;

        const dbStates = await RegistrationState.find({ bot_id: profileScope });
        const mergedStates = { users: { ...fallbackStates.users } };
        for (const doc of dbStates) {
            try {
                mergedStates.users[doc.jid] = JSON.parse(doc.payload || '{}');
            } catch {}
        }
        memoryCache.states[profileScope] = mergedStates;

        const dbChats = await ChatbotMemory.find({ 
            $or: [
                { bot_id: normalizedBotId }, 
                { bot_id: { $exists: false } }
            ] 
        });
        const mergedChatMem = { ...fallbackChatMem };
        for (const doc of dbChats) {
            try {
                let actualUserId = doc.user_id;
                if (actualUserId && actualUserId.startsWith(`${normalizedBotId}_`)) {
                    actualUserId = actualUserId.slice(normalizedBotId.length + 1);
                }
                mergedChatMem[actualUserId] = JSON.parse(doc.payload || '{}');
            } catch {}
        }
        memoryCache.chatMem[normalizedBotId] = mergedChatMem;

        const fallbackEconomy = memoryCache.economy[normalizedBotId] || (
            normalizedBotId === '__shared__'
                ? readEconomyMirror()
                : { users: {}, meta: {} }
        );
        const dbEconomy = await EconomyData.findOne({ bot_id: normalizedBotId });
        if (dbEconomy) {
            try {
                memoryCache.economy[normalizedBotId] = JSON.parse(dbEconomy.payload || '{}');
            } catch {}
        } else {
            memoryCache.economy[normalizedBotId] = fallbackEconomy;
        }

        const dbStaff = await StaffRoles.findOne({ bot_id: normalizedBotId });
        if (dbStaff) {
            try {
                memoryCache.staff[normalizedBotId] = JSON.parse(dbStaff.payload || '{ "coOwners": [], "mods": [], "staff": [] }');
            } catch {}
        } else {
            memoryCache.staff[normalizedBotId] = readStaffRolesMirror();
        }

        syncedBots.add(normalizedBotId);

        console.log(`MongoDB sync complete for ${normalizedBotId}. Profiles: ${dbProfiles.length}`);
        return true;
    } catch (err) {
        console.error('MongoDB sync failed:', err?.message || err);
        scheduleReconnect('sync-failed');
        return false;
    }
}

mongoose.connection.removeAllListeners('connected');
mongoose.connection.removeAllListeners('disconnected');
mongoose.connection.removeAllListeners('error');

mongoose.connection.on('connected', () => {
    mongoConnected = true;
});

mongoose.connection.on('disconnected', () => {
    mongoConnected = false;
    if (mongoEnabled) {
        console.warn('[mongo] disconnected, continuing with memory/cache fallback');
        scheduleReconnect('disconnected');
    }
});

mongoose.connection.on('error', (err) => {
    mongoConnected = false;
    logMongoIssue('error', '[mongo] connection error', err);
    scheduleReconnect('connection-error');
});

connectMongo('startup').catch(() => null);

function getDatabasePath() {
    return 'mongodb';
}

function readRegistrationProfiles() {
    const scope = getRegistrationScope();
    const scoped = getScopedProfilesCache(scope);
    if (!Object.keys(scoped.users || {}).length) {
        memoryCache.profiles[scope] = readProfilesMirror();
    }
    return clone(memoryCache.profiles[scope]);
}

function writeRegistrationProfiles(profiles, options = {}) {
    const scope = getRegistrationScope();
    const next = profiles && typeof profiles === 'object' ? profiles : { users: {}, aliases: {} };
    const users = next.users || {};
    const aliases = next.aliases || {};
    const now = Date.now();

    memoryCache.profiles[scope] = clone(next);
    flushProfilesToMongo(users, aliases, now, scope).catch(() => null);

    // Always write JSON mirror immediately — ensures restarts never lose registrations
    if (shouldUseJsonMirror('profiles') && options.mirrorJson !== false) {
        ensureSharedDataDir();
        writeJsonSafe(SHARED_PROFILES_FILE, { users, aliases });
        lastMirrorAt.profiles = now;
    }
}

function readRegistrationState() {
    const scope = getRegistrationScope();
    const scoped = getScopedStatesCache(scope);
    if (!Object.keys(scoped.users || {}).length) {
        memoryCache.states[scope] = readStatesMirror();
    }
    return clone(memoryCache.states[scope]);
}

function writeRegistrationState(state, options = {}) {
    const scope = getRegistrationScope();
    const next = state && typeof state === 'object' ? state : { users: {} };
    const users = next.users || {};
    const now = Date.now();

    memoryCache.states[scope] = clone(next);
    flushStatesToMongo(users, now, scope).catch(() => null);

    if (shouldUseJsonMirror('states') && options.mirrorJson !== false && now - lastMirrorAt.states >= MIRROR_INTERVAL) {
        ensureSharedDataDir();
        const statePath = SHARED_STATES_FILE;
        writeJsonSafe(statePath, { users });
        lastMirrorAt.states = now;
    }
}

function readChatbotMemory() {
    const botId = getBotId();
    const scoped = getScopedChatMemCache(botId);
    if (!Object.keys(scoped || {}).length) {
        memoryCache.chatMem[botId] = readChatMemoryMirror(botId);
    }
    return clone(memoryCache.chatMem[botId]);
}

function writeChatbotMemory(memoryDb, userId, options = {}) {
    const botId = getBotId();
    const next = memoryDb && typeof memoryDb === 'object' ? memoryDb : {};
    const now = Date.now();

    getScopedChatMemCache(botId);
    if (userId) {
        if (!next[userId]) {
            delete memoryCache.chatMem[botId][userId];
        } else {
            memoryCache.chatMem[botId][userId] = clone(next[userId]);
        }
    } else {
        memoryCache.chatMem[botId] = clone(next);
    }

    flushChatMemoryToMongo(next, userId || '', now, botId).catch(() => null);

    if (shouldUseJsonMirror('chatMem') && options.mirrorJson !== false && now - lastMirrorAt.chatMem >= MIRROR_INTERVAL) {
        const memoryPath = getBotDataPath('memory.json');
        writeJsonSafe(memoryPath, next);
        lastMirrorAt.chatMem = now;
    }
}

function getRawRegistrationProfiles() {
    const scope = getRegistrationScope();
    const scoped = getScopedProfilesCache(scope);
    if (!Object.keys(scoped.users || {}).length) {
        memoryCache.profiles[scope] = readProfilesMirror();
    }
    return memoryCache.profiles[scope];
}

function getRawRegistrationState() {
    const scope = getRegistrationScope();
    const scoped = getScopedStatesCache(scope);
    if (!Object.keys(scoped.users || {}).length) {
        memoryCache.states[scope] = readStatesMirror();
    }
    return memoryCache.states[scope];
}

const persistentCache = new Map();

async function setPersistentValue(key, value) {
    const stringified = JSON.stringify(value);
    persistentCache.set(key, value);
    
    if (!hasMongoConnection()) {
        pendingWrites.persistent[key] = { value }; // FIXED: queue persistent writes while Mongo is offline
        return false;
    }
    try {
        await StorageMeta.updateOne(
            { key },
            { key, value: stringified },
            { upsert: true }
        );
        return true;
    } catch (err) {
        console.error(`[mongo] setPersistentValue error (${key}):`, err);
        return false;
    }
}

async function getPersistentValue(key, fallback = null) {
    if (persistentCache.has(key)) return persistentCache.get(key);
    if (Object.prototype.hasOwnProperty.call(pendingWrites.persistent, key)) {
        return pendingWrites.persistent[key].value; // FIXED: read queued persistent values before Mongo sync
    }
    
    if (!hasMongoConnection()) return fallback;
    try {
        const doc = await StorageMeta.findOne({ key });
        const val = doc ? JSON.parse(doc.value) : fallback;
        persistentCache.set(key, val);
        return val;
    } catch (err) {
        console.error(`[mongo] getPersistentValue error (${key}):`, err);
        return fallback;
    }
}

function readEconomy(botIdOverride) {
    const botId = String(botIdOverride || getBotId() || '').trim().toLowerCase() || getBotId();
    if (!memoryCache.economy[botId]) {
        memoryCache.economy[botId] = botId === '__shared__'
            ? readEconomyMirror()
            : { users: {}, meta: {} };
    }
    return clone(memoryCache.economy[botId]);
}

function writeEconomy(db, options = {}) {
    const botId = String(options.botId || getBotId() || '').trim().toLowerCase() || getBotId();
    const now = Date.now();
    const safeDb = preserveEconomyBanks(memoryCache.economy[botId], db, options);
    memoryCache.economy[botId] = clone(safeDb || {});
    flushEconomyToMongo(safeDb, now, botId, options).catch(() => null);

    if (ENABLE_ECONOMY_JSON_MIRROR && options.mirrorJson !== false && now - lastMirrorAt.economy >= MIRROR_INTERVAL) {
        const economyPath = path.join(SHARED_DATA_DIR, 'economy.json');
        writeJsonSafe(economyPath, safeDb);
        lastMirrorAt.economy = now;
    }
}

function readStaffRoles() {
    const botId = getBotId();
    if (!memoryCache.staff[botId]) {
        memoryCache.staff[botId] = readStaffRolesMirror();
    }
    return clone(memoryCache.staff[botId]);
}

function writeStaffRoles(roles, options = {}) {
    const botId = getBotId();
    const now = Date.now();
    memoryCache.staff[botId] = clone(roles || {});
    flushStaffToMongo(roles, now, botId).catch(() => null);

    if (shouldUseJsonMirror('staff') && options.mirrorJson !== false && now - lastMirrorAt.staff >= MIRROR_INTERVAL) {
        const staffPath = path.join(SHARED_DATA_DIR, 'staffRoles.json');
        writeJsonSafe(staffPath, roles);
        lastMirrorAt.staff = now;
    }
}

async function ensureMongoReady(botId = getBotId()) {
    const normalizedBotId = String(botId || getBotId() || '').trim().toLowerCase() || getBotId();
    if (syncedBots.has(normalizedBotId) && hasMongoConnection()) {
        return true;
    }
    if (syncPromises.has(normalizedBotId)) {
        return syncPromises.get(normalizedBotId);
    }

    const pending = (async () => {
        const connected = await connectMongo(`ensure:${normalizedBotId}`).catch(() => false);
        if (!connected) return false;
        return syncFromMongo(true, normalizedBotId);
    })().finally(() => {
        syncPromises.delete(normalizedBotId);
    });

    syncPromises.set(normalizedBotId, pending);
    return pending;
}


module.exports = {
    clone,
    getDatabasePath,
    readRegistrationProfiles,
    writeRegistrationProfiles,
    readRegistrationState,
    writeRegistrationState,
    readChatbotMemory,
    writeChatbotMemory,
    readEconomy,
    writeEconomy,
    readStaffRoles,
    writeStaffRoles,
    ensureMongoReady,
    syncFromMongo,
    isSynced: (botId = getBotId()) => syncedBots.has(String(botId || getBotId() || '').trim().toLowerCase() || getBotId()),
    isMongoConnected: () => hasMongoConnection(),
    getRawRegistrationProfiles,
    getRawRegistrationState,
    setPersistentValue,
    getPersistentValue,
    StorageMeta,
    RegistrationProfile,
    RegistrationAlias,
    RegistrationState,
    ChatbotMemory,
    EconomyData,
    StaffRoles
};

