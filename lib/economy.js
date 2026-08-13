const fs = require('fs');
const path = require('path');
const { Mutex } = require('async-mutex');
const { readEconomy, writeEconomy, ensureMongoReady, EconomyData } = require('./mongoStore');
const { EconomyLedgerModel } = require('./rpg/models');
const { normalizePlayerJid } = require('./rpg/identity');
const {
    mirrorWalletState,
    recordLedgerEntry,
    backfillLegacyEconomy,
    makeTxId
} = require('./rpg/economyFoundation');
const {
    awardRegistrationProgress,
    getRegisteredProfile,
    setRegisteredNetwork,
    getUnlockedNetworks,
    resolveRegisteredJid,
    getLinkedRegisteredJids
} = require('./registrationStore');
const {
    NETWORKS,
    SWITCH_COOLDOWN_MS,
    SWITCH_BLOCK_AFTER_DEPOSIT_MS,
    normalizeNetwork,
    canAccessNetwork,
    getSwitchBaseCost,
    getCardSwitchDiscount
} = require('./bankSystem');


const CHAT_COOLDOWN_MS = 25_000;
const CHAT_DAILY_CAP = 200;
const MIN_MSG_LENGTH = 4;
const REVIVE_GAP_MS = 60 * 60 * 1000;
const SHARED_ECONOMY_BOT_ID = '__shared__';
const LEGACY_ECONOMY_BOT_IDS = ['eclipse', 'reze'];

const MISSIONS = {
    chat15: { label: 'send 15 valid msgs today', goal: 15, reward: 25 },
    reply3: { label: 'reply to 3 different users', goal: 3, reward: 20 },
    revive: { label: 'revive dead chat after 1h', goal: 1, reward: 30 },
    challenge: { label: 'win a mini challenge', goal: 1, reward: 40 }
};

const dbCacheByBot = new Map();
const seededFoundationBots = new Set();
const economyMutexByBot = new Map();
let sharedEconomyReadyPromise = null;

function getEconomyBotId() {
    return SHARED_ECONOMY_BOT_ID; // FIXED: shared economy across all bot profiles
}

function getEconomyMutex(botId = getEconomyBotId()) {
    const key = String(botId || getEconomyBotId()).trim().toLowerCase() || SHARED_ECONOMY_BOT_ID;
    if (!economyMutexByBot.has(key)) {
        economyMutexByBot.set(key, new Mutex());
    }
    return economyMutexByBot.get(key); // FIXED: shared economy mutex by bot scope
}

function totalAssetsForMerge(user = {}) {
    const wallet = Math.max(0, Number(user.wallet || 0));
    const banks = Object.values(user.banks || {}).reduce((sum, value) => sum + Math.max(0, Number(value || 0)), 0);
    return wallet + banks;
}

function mergeEconomyUsers(baseUsers = {}, nextUsers = {}) {
    const merged = { ...baseUsers };
    for (const [jid, raw] of Object.entries(nextUsers || {})) {
        const incoming = migrateLegacyUser(raw || {}, jid);
        const current = merged[jid] ? migrateLegacyUser(merged[jid] || {}, jid) : null;
        if (!current || totalAssetsForMerge(incoming) >= totalAssetsForMerge(current)) {
            merged[jid] = incoming; // FIXED: merge shared economy by keeping richer user snapshot
        }
    }
    return merged;
}

async function ensureSharedEconomyReady() {
    if (sharedEconomyReadyPromise) {
        return sharedEconomyReadyPromise;
    }

    let shouldRetryHydration = false;
    sharedEconomyReadyPromise = getEconomyMutex(SHARED_ECONOMY_BOT_ID).runExclusive(async () => {
        const sharedSynced = await ensureMongoReady(SHARED_ECONOMY_BOT_ID).catch(() => false);
        const sharedDb = readEconomy(SHARED_ECONOMY_BOT_ID) || {};
        const currentUsers = Object.keys(sharedDb.users || {}).length;
        if (sharedSynced && currentUsers > 0) {
            dbCacheByBot.set(SHARED_ECONOMY_BOT_ID, sharedDb);
            return true;
        }

        let mergedUsers = {};
        let mergedMeta = {};
        for (const botId of LEGACY_ECONOMY_BOT_IDS) {
            try {
                const legacySynced = await ensureMongoReady(botId).catch(() => false);
                if (!legacySynced) continue;
                const doc = await EconomyData.findOne({ bot_id: botId }).lean();
                const parsed = JSON.parse(doc?.payload || '{}');
                mergedUsers = mergeEconomyUsers(mergedUsers, parsed.users || {});
                mergedMeta = { ...mergedMeta, ...(parsed.meta || {}) };
            } catch (error) {
                console.error(`[economy] shared merge skipped for ${botId}:`, error?.message || error);
            }
        }

        if (Object.keys(mergedUsers).length > 0) {
            const mergedDb = { users: mergedUsers, meta: mergedMeta };
            if (!sharedSynced && currentUsers > Object.keys(mergedUsers).length) {
                dbCacheByBot.set(SHARED_ECONOMY_BOT_ID, sharedDb);
                shouldRetryHydration = true;
                return false;
            }
            dbCacheByBot.set(SHARED_ECONOMY_BOT_ID, mergedDb);
            if (sharedSynced) {
                writeEconomy(mergedDb, { botId: SHARED_ECONOMY_BOT_ID }); // FIXED: persist one shared economy document under mutex
                return true;
            }
            shouldRetryHydration = true;
            return false;
        }

        if (currentUsers > 0) {
            dbCacheByBot.set(SHARED_ECONOMY_BOT_ID, sharedDb);
        }
        if (!sharedSynced) {
            shouldRetryHydration = true;
            return false;
        }
        return true;
    }).catch((error) => {
        console.error('[economy] ensureSharedEconomyReady failed:', error?.message || error);
        shouldRetryHydration = true;
        return false;
    }).finally(() => {
        if (shouldRetryHydration) {
            sharedEconomyReadyPromise = null; // FIXED: do not permanently trust fallback shared economy hydration
        }
    });

    return sharedEconomyReadyPromise;
}

async function reconcileBankStateFromLedger(jid, opts = {}) {
    const canonicalJid = canonicalizeEconomyJid(jid);
    if (!canonicalJid) return { ok: false, reason: 'invalid_jid' };

    const normalizedLedgerJids = [...new Set(
        getLinkedRegisteredJids(canonicalJid)
            .map((value) => normalizePlayerJid(value))
            .filter(Boolean)
    )];

    if (!normalizedLedgerJids.length) {
        normalizedLedgerJids.push(normalizePlayerJid(canonicalJid));
    }

    const rows = await EconomyLedgerModel.find({
        bot_id: SHARED_ECONOMY_BOT_ID,
        jid: { $in: normalizedLedgerJids },
        category: 'bank'
    }).sort({ created_at: 1, _id: 1 }).lean().catch(() => []);

    const reconciledBanks = ensureBankMap({});
    for (const row of rows) {
        const network = normalizeNetwork(row?.meta?.network) || 'Wistoria';
        if (row?.source === 'deposit_to_bank') {
            const credited = Math.max(0, Number(row?.meta?.credited ?? row?.meta?.deposited ?? 0));
            reconciledBanks[network] = Math.max(0, Number(reconciledBanks[network] || 0) + credited);
        } else if (row?.source === 'withdraw_from_bank') {
            const amount = Math.max(0, Number(row?.meta?.amount || 0));
            reconciledBanks[network] = Math.max(0, Number(reconciledBanks[network] || 0) - amount);
        }
    }

    const totalReconciled = Object.values(reconciledBanks).reduce((sum, value) => sum + Math.max(0, Number(value || 0)), 0);
    const botId = getEconomyBotId();
    const db = loadDB(botId);
    const user = getUser(db, canonicalJid);
    const currentTotal = Object.values(ensureBankMap(user.banks || {})).reduce((sum, value) => sum + Math.max(0, Number(value || 0)), 0);

    if (!opts.force && totalReconciled <= currentTotal) {
        return {
            ok: true,
            updated: false,
            jid: canonicalJid,
            currentBanks: ensureBankMap(user.banks || {}),
            reconciledBanks
        };
    }

    user.banks = ensureBankMap(reconciledBanks);
    saveDB(db, false, botId);
    await mirrorWalletState({
        botId,
        jid: canonicalJid,
        wallet: Number(user.wallet || 0),
        activeNetwork: user.activeNetwork || 'Wistoria',
        banks: user.banks || {},
        txMeta: user.txMeta || {},
        source: 'ledger_bank_reconcile'
    }).catch(() => false);

    return {
        ok: true,
        updated: true,
        jid: canonicalJid,
        currentBanks: ensureBankMap(user.banks || {}),
        reconciledBanks
    };
}

async function reconcileEconomyStateFromLedger(jid, opts = {}) {
    const canonicalJid = canonicalizeEconomyJid(jid);
    if (!canonicalJid) return { ok: false, reason: 'invalid_jid' };

    const normalizedLedgerJids = [...new Set(
        getLinkedRegisteredJids(canonicalJid)
            .map((value) => normalizePlayerJid(value))
            .filter(Boolean)
    )];
    if (!normalizedLedgerJids.length) normalizedLedgerJids.push(normalizePlayerJid(canonicalJid));

    const rows = await EconomyLedgerModel.find({
        bot_id: SHARED_ECONOMY_BOT_ID,
        jid: { $in: normalizedLedgerJids },
        status: 'applied'
    }).sort({ created_at: 1, _id: 1 }).lean().catch(() => []);

    if (!rows.length) return { ok: false, reason: 'no_ledger_rows', jid: canonicalJid };

    let wallet = null;
    let discontinuities = 0;
    const banks = ensureBankMap({});

    for (const row of rows) {
        const before = Math.max(0, Number(row.before || 0));
        const delta = Number(row.delta || 0);
        if (wallet === null) wallet = before;

        if (Math.abs(wallet - before) > 0) {
            discontinuities += 1;
            if (before > wallet) {
                wallet = before;
            }
        }

        wallet = Math.max(0, wallet + delta);

        const network = normalizeNetwork(row?.meta?.network) || 'Wistoria';
        if (row?.source === 'deposit_to_bank') {
            const credited = Math.max(0, Number(row?.meta?.credited ?? row?.meta?.deposited ?? 0));
            banks[network] = Math.max(0, Number(banks[network] || 0) + credited);
        } else if (row?.source === 'withdraw_from_bank') {
            const amount = Math.max(0, Number(row?.meta?.amount || 0));
            banks[network] = Math.max(0, Number(banks[network] || 0) - amount);
        }
    }

    const botId = getEconomyBotId();
    const db = loadDB(botId);
    const user = getUser(db, canonicalJid);
    const currentWallet = Math.max(0, Number(user.wallet || 0));
    const nextWallet = opts.force ? wallet : Math.max(currentWallet, wallet);

    user.wallet = Math.max(0, Number(nextWallet || 0));
    user.banks = ensureBankMap(banks);
    saveDB(db, { allowBankShrink: opts.force === true, source: 'ledger_full_reconcile' }, botId);
    await mirrorWalletState({
        botId,
        jid: canonicalJid,
        wallet: user.wallet,
        activeNetwork: user.activeNetwork || 'Wistoria',
        banks: user.banks || {},
        txMeta: user.txMeta || {},
        source: 'ledger_full_reconcile'
    }).catch(() => false);

    return {
        ok: true,
        jid: canonicalJid,
        wallet: user.wallet,
        banks: ensureBankMap(user.banks || {}),
        rows: rows.length,
        discontinuities
    };
}

function loadDB(botId = getEconomyBotId()) {
    const latest = readEconomy(botId);
    if (dbCacheByBot.has(botId)) {
        const cached = dbCacheByBot.get(botId);
        const cachedUsers = Object.keys(cached?.users || {}).length;
        const latestUsers = Object.keys(latest?.users || {}).length;
        if ((cachedUsers === 0 && latestUsers > 0) || latestUsers > cachedUsers) {
            dbCacheByBot.set(botId, latest); // FIXED: refresh stale empty economy cache after Mongo sync
            return latest;
        }
        return cached;
    }
    const db = latest;
    dbCacheByBot.set(botId, db);
    if (!seededFoundationBots.has(botId) && db?.users && typeof db.users === 'object') {
        seededFoundationBots.add(botId);
        backfillLegacyEconomy(botId, db).catch((error) => {
            console.error('[economy] foundation backfill failed:', error?.message || error);
        });
    }
    return db;
}

function saveDB(db, force = false, botId = getEconomyBotId()) {
    const options = force && typeof force === 'object'
        ? { ...force }
        : { mirrorJson: force === true };
    dbCacheByBot.set(botId, db);
    writeEconomy(db, { ...options, botId });
}

function saveOnExit() {
    for (const [botId, db] of dbCacheByBot.entries()) {
        writeEconomy(db, { botId }); // FIXED: Mongo-only economy shutdown persistence
    }
    process.exit(0);
}

function mirrorUserStateAsync(botId, jid, user, source = 'legacy_sync') {
    if (!jid || !user) return;
    mirrorWalletState({
        botId,
        jid,
        wallet: Number(user.wallet || 0),
        activeNetwork: user.activeNetwork || 'Wistoria',
        banks: user.banks || {},
        txMeta: user.txMeta || {},
        source
    }).catch((error) => {
        console.error('[economy] mirrorUserStateAsync failed:', error?.message || error);
    });
}

function recordLedgerAsync({
    botId,
    jid,
    delta,
    before,
    after,
    actorJid = '',
    source = 'economy',
    category = 'economy',
    meta = {},
    txId = ''
} = {}) {
    if (!jid || !Number.isFinite(Number(delta || 0))) return;
    recordLedgerEntry({
        botId,
        jid,
        delta: Number(delta || 0),
        before: Math.max(0, Number(before || 0)),
        after: Math.max(0, Number(after || 0)),
        actorJid,
        source,
        category,
        meta,
        txId: String(txId || makeTxId(source)).trim() || makeTxId(source)
    }).catch((error) => {
        console.error('[economy] recordLedgerAsync failed:', error?.message || error);
    });
}

global.__economySaveOnExit = saveOnExit; // FIXED: shared shutdown callback for hot reloads
if (!global.__economySignalHandlersBound) {
    global.__economySignalHandlersBound = true;
    process.once('SIGINT', () => global.__economySaveOnExit?.()); // FIXED: single SIGINT listener across reloads
    process.once('SIGTERM', () => global.__economySaveOnExit?.()); // FIXED: single SIGTERM listener across reloads
}


function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

function normalizeEconomyUserId(value) {
    return String(value || '').split('@')[0].replace(/\D/g, '');
}

function canonicalizeEconomyJid(jid) {
    const canonical = resolveRegisteredJid(jid);
    return String(canonical || jid || '').trim();
}

function resolveEconomyUserKey(users, jid) {
    if (!users || typeof users !== 'object') return null;
    if (jid && Object.prototype.hasOwnProperty.call(users, jid)) return jid;

    const normalized = normalizeEconomyUserId(jid);
    if (!normalized) return null;

    for (const key of Object.keys(users)) {
        if (normalizeEconomyUserId(key) === normalized) {
            return key;
        }
    }

    return null;
}

function collectEconomyUserKeys(users, jid) {
    if (!users || typeof users !== 'object') return [];
    const linked = getLinkedRegisteredJids(jid);
    const linkedSet = new Set(linked.map((value) => String(value || '').trim()).filter(Boolean));

    if (linkedSet.size > 0) {
        return Object.keys(users).filter((key) => linkedSet.has(String(key || '').trim()));
    }

    const normalized = normalizeEconomyUserId(jid);
    if (!normalized) return [];
    return Object.keys(users).filter((key) => normalizeEconomyUserId(key) === normalized);
}

function pickBestEconomyUserKey(users, keys = []) {
    let bestKey = '';
    let bestAssets = -1;

    for (const key of keys) {
        const migrated = migrateLegacyUser(users?.[key] || {}, key);
        const assets = totalAssetsOfUser(migrated);
        if (assets > bestAssets) {
            bestAssets = assets;
            bestKey = key;
        }
    }

    return bestKey;
}

function ensureBankMap(banks = {}) {
    const next = { ...banks };
    const legacyBase = Math.max(0, Number((next.Wistoria ?? next.Eclipse) || 0));
    next.Wistoria = legacyBase; // FIXED: migrate legacy Eclipse bank balances into Wistoria
    delete next.Eclipse;
    for (const key of Object.keys(NETWORKS)) {
        next[key] = Math.max(0, Number(next[key] || 0));
    }
    return next;
}

function ensureTxMeta(meta = {}) {
    return {
        System: {
            lastDepositAt: Number(meta?.System?.lastDepositAt || 0),
            lastSwitchAt: Number(meta?.System?.lastSwitchAt || 0)
        },
        Neon: {
            recentTransactions: Array.isArray(meta?.Neon?.recentTransactions)
                ? meta.Neon.recentTransactions.map(Number).filter(Boolean)
                : []
        },
        Titan: {
            lastDepositAt: Number(meta?.Titan?.lastDepositAt || 0),
            pendingWithdrawals: Array.isArray(meta?.Titan?.pendingWithdrawals)
                ? meta.Titan.pendingWithdrawals.map((entry) => ({
                    amount: Math.max(0, Number(entry?.amount || 0)),
                    readyAt: Math.max(0, Number(entry?.readyAt || 0)),
                    createdAt: Math.max(0, Number(entry?.createdAt || 0))
                }))
                : []
        },
        Glitch: {
            phantomBalance: Math.max(0, Number(meta?.Glitch?.phantomBalance || 0))
        }
    };
}

function migrateLegacyUser(user, jid) {
    const registered = getRegisteredProfile(jid);
    const activeNetwork = normalizeNetwork(user.activeNetwork || registered?.network || 'Wistoria') || 'Wistoria';
    const wallet = Number.isFinite(Number(user.wallet))
        ? Number(user.wallet)
        : Math.max(0, Number(user.balance || 0));

    return {
        wallet: Math.max(0, wallet),
        activeNetwork,
        banks: ensureBankMap(user.banks),
        txMeta: ensureTxMeta(user.txMeta),
        lastChat: Number(user.lastChat || 0),
        lastMessage: String(user.lastMessage || ''),
        chatEarnedToday: Number(user.chatEarnedToday || 0),
        chatEarnDate: String(user.chatEarnDate || ''),
        lastDaily: String(user.lastDaily || ''),
        streak: Number(user.streak || 0),
        missions: user.missions && typeof user.missions === 'object' ? user.missions : {},
        lastMissionDate: String(user.lastMissionDate || ''),
        missionMeta: {
            replyUsers: Array.isArray(user.missionMeta?.replyUsers) ? user.missionMeta.replyUsers : [],
            lastValidMessage: String(user.missionMeta?.lastValidMessage || '')
        }
    };
}

function getUser(db, jid) {
    if (!db.users) db.users = {};
    if (!db.meta) db.meta = {};
    if (!db.meta.chats) db.meta.chats = {};

    const canonicalJid = canonicalizeEconomyJid(jid);
    const duplicateKeys = collectEconomyUserKeys(db.users, canonicalJid);
    const resolvedKey = duplicateKeys.length
        ? pickBestEconomyUserKey(db.users, duplicateKeys)
        : resolveEconomyUserKey(db.users, canonicalJid);
    const sourceKey = resolvedKey || canonicalJid;
    const migrated = migrateLegacyUser(db.users[sourceKey] || {}, sourceKey);

    for (const key of duplicateKeys) {
        if (key !== canonicalJid) {
            delete db.users[key];
        }
    }

    if (!duplicateKeys.length && resolvedKey && resolvedKey !== canonicalJid) {
        delete db.users[resolvedKey];
    }

    db.users[canonicalJid] = {
        ...migrated,
        activeNetwork: normalizeNetwork(migrated.activeNetwork || 'Wistoria') || 'Wistoria'
    };

    return db.users[canonicalJid];
}

function ensureMissionDay(user, today) {
    if (user.lastMissionDate !== today) {
        user.missions = {};
        user.lastMissionDate = today;
        user.missionMeta = { replyUsers: [], lastValidMessage: '' };
    }
}

function addWallet(user, amount) {
    user.wallet = Math.max(0, Number(user.wallet || 0) + Number(amount || 0));
    return user.wallet;
}

function addMissionProgress(user, key, amount = 1) {
    const mission = MISSIONS[key];
    if (!mission) return null;

    if (!user.missions[key]) {
        user.missions[key] = { progress: 0, completed: false };
    }
    const state = user.missions[key];
    if (state.completed) {
        return { progress: state.progress, goal: mission.goal, rewarded: false, reward: mission.reward };
    }

    state.progress += amount;
    let rewarded = false;
    if (state.progress >= mission.goal) {
        state.completed = true;
        addWallet(user, mission.reward);
        rewarded = true;
    }
    return { progress: state.progress, goal: mission.goal, rewarded, reward: mission.reward };
}

function settlePendingWithdrawalsForUser(user, now = Date.now()) {
    const pending = user.txMeta.Titan.pendingWithdrawals;
    if (!pending.length) return 0;

    let released = 0;
    const keep = [];
    for (const entry of pending) {
        if (entry.readyAt <= now) {
            released += entry.amount;
        } else {
            keep.push(entry);
        }
    }
    user.txMeta.Titan.pendingWithdrawals = keep;
    if (released > 0) addWallet(user, released);
    return released;
}

function totalAssetsOfUser(user) {
    return Math.max(0, Number(user.wallet || 0)) +
        Object.values(ensureBankMap(user.banks)).reduce((sum, value) => sum + Number(value || 0), 0);
}

function getActiveNetwork(jid) {
    const botId = getEconomyBotId();
    const db = loadDB(botId);
    const user = getUser(db, jid);
    const released = settlePendingWithdrawalsForUser(user);
    if (released > 0) saveDB(db, false, botId);
    return user.activeNetwork || 'Wistoria';
}

function getBankBalance(jid, network) {
    const botId = getEconomyBotId();
    const db = loadDB(botId);
    const user = getUser(db, jid);
    const released = settlePendingWithdrawalsForUser(user);
    if (released > 0) saveDB(db, false, botId);
    const key = normalizeNetwork(network || user.activeNetwork) || user.activeNetwork || 'Wistoria';
    return Math.max(0, Number(user.banks[key] || 0));
}

function getBalance(jid) {
    const botId = getEconomyBotId();
    const db = loadDB(botId);
    const user = getUser(db, jid);
    const released = settlePendingWithdrawalsForUser(user);
    if (released > 0) saveDB(db, false, botId);
    return Math.max(0, Number(user.wallet || 0));
}

function applyBalanceDelta(db, botId, jid, amount, opts = {}) {
    const user = getUser(db, jid);
    settlePendingWithdrawalsForUser(user);
    const delta = Number(amount || 0);
    const before = Math.max(0, Number(user.wallet || 0));
    addWallet(user, delta);
    saveDB(db, opts.force === true, botId);
    mirrorUserStateAsync(botId, jid, user, opts.source || 'add_balance');
    if (delta !== 0) {
        recordLedgerAsync({
            botId,
            jid,
            delta,
            before,
            after: Math.max(0, Number(user.wallet || 0)),
            actorJid: opts.actorJid || jid,
            source: opts.source || 'add_balance',
            category: opts.category || 'economy',
            meta: opts.meta || {},
            txId: opts.txId || ''
        });
    }

    if (delta > 0 && opts.awardXp !== false) {
        awardRegistrationProgress(jid, delta);
    }
    return user.wallet;
}

function addBalance(jid, amount, opts = {}) {
    const botId = getEconomyBotId();
    const db = loadDB(botId);
    return applyBalanceDelta(db, botId, jid, amount, opts);
}

async function addBalanceAtomic(jid, amount, opts = {}) {
    const botId = getEconomyBotId();
    return getEconomyMutex(botId).runExclusive(async () => {
        const db = loadDB(botId);
        return applyBalanceDelta(db, botId, jid, amount, opts);
    });
}

async function transferBalanceAtomic(fromJid, toJid, amount, opts = {}) {
    const botId = getEconomyBotId();
    return getEconomyMutex(botId).runExclusive(async () => {
        const db = loadDB(botId);
        const fromUser = getUser(db, fromJid);
        const toUser = getUser(db, toJid);
        settlePendingWithdrawalsForUser(fromUser);
        settlePendingWithdrawalsForUser(toUser);

        const rawAmount = Math.max(0, Math.floor(Number(amount || 0)));
        if (!rawAmount) {
            return { ok: false, reason: 'invalid_amount', amount: 0 };
        }

        const fromBefore = Math.max(0, Number(fromUser.wallet || 0));
        if (fromBefore < rawAmount) {
            return { ok: false, reason: 'insufficient_wallet', wallet: fromBefore, amount: rawAmount };
        }

        const toBefore = Math.max(0, Number(toUser.wallet || 0));
        addWallet(fromUser, -rawAmount);
        addWallet(toUser, rawAmount);
        saveDB(db, opts.force === true, botId);
        mirrorUserStateAsync(botId, fromJid, fromUser, opts.source || 'transfer_balance');
        mirrorUserStateAsync(botId, toJid, toUser, opts.source || 'transfer_balance');
        recordLedgerAsync({
            botId,
            jid: fromJid,
            delta: -rawAmount,
            before: fromBefore,
            after: Math.max(0, Number(fromUser.wallet || 0)),
            actorJid: opts.actorJid || fromJid,
            source: opts.source || 'transfer_balance',
            category: opts.category || 'economy',
            meta: { ...(opts.meta || {}), direction: 'out', targetJid: toJid },
            txId: opts.txId || ''
        });
        recordLedgerAsync({
            botId,
            jid: toJid,
            delta: rawAmount,
            before: toBefore,
            after: Math.max(0, Number(toUser.wallet || 0)),
            actorJid: opts.actorJid || fromJid,
            source: opts.source || 'transfer_balance',
            category: opts.category || 'economy',
            meta: { ...(opts.meta || {}), direction: 'in', sourceJid: fromJid },
            txId: opts.txId || ''
        });

        if (opts.awardXp === true) {
            awardRegistrationProgress(toJid, rawAmount);
        }

        return {
            ok: true,
            amount: rawAmount,
            fromBalance: Math.max(0, Number(fromUser.wallet || 0)),
            toBalance: Math.max(0, Number(toUser.wallet || 0))
        };
    });
}

async function applyBalanceBatchAtomic(entries = [], opts = {}) {
    const botId = getEconomyBotId();
    return getEconomyMutex(botId).runExclusive(async () => {
        const db = loadDB(botId);
        const normalizedEntries = (Array.isArray(entries) ? entries : [])
            .map((entry) => ({
                jid: String(entry?.jid || '').trim(),
                delta: Number(entry?.delta || 0),
                awardXp: entry?.awardXp !== false,
                actorJid: entry?.actorJid || '',
                source: entry?.source || opts.source || 'batch_balance',
                category: entry?.category || opts.category || 'economy',
                meta: entry?.meta || opts.meta || {},
                txId: entry?.txId || opts.txId || ''
            }))
            .filter((entry) => entry.jid && Number.isFinite(entry.delta) && entry.delta !== 0);

        if (!normalizedEntries.length) {
            return { ok: false, reason: 'no_entries' };
        }

        const snapshots = normalizedEntries.map((entry) => {
            const user = getUser(db, entry.jid);
            settlePendingWithdrawalsForUser(user);
            return {
                entry,
                user,
                before: Math.max(0, Number(user.wallet || 0))
            };
        });

        for (const item of snapshots) {
            const after = item.before + item.entry.delta;
            if (after < 0) {
                return {
                    ok: false,
                    reason: 'insufficient_wallet',
                    jid: item.entry.jid,
                    wallet: item.before,
                    delta: item.entry.delta
                };
            }
        }

        for (const item of snapshots) {
            addWallet(item.user, item.entry.delta);
        }

        saveDB(db, opts.force === true, botId);

        for (const item of snapshots) {
            mirrorUserStateAsync(botId, item.entry.jid, item.user, item.entry.source);
            recordLedgerAsync({
                botId,
                jid: item.entry.jid,
                delta: item.entry.delta,
                before: item.before,
                after: Math.max(0, Number(item.user.wallet || 0)),
                actorJid: item.entry.actorJid || item.entry.jid,
                source: item.entry.source,
                category: item.entry.category,
                meta: item.entry.meta,
                txId: item.entry.txId
            });
            if (item.entry.delta > 0 && item.entry.awardXp) {
                awardRegistrationProgress(item.entry.jid, item.entry.delta);
            }
        }

        return {
            ok: true,
            balances: snapshots.map((item) => ({
                jid: item.entry.jid,
                before: item.before,
                after: Math.max(0, Number(item.user.wallet || 0)),
                delta: item.entry.delta
            }))
        };
    });
}

function getEconomySnapshot(jid) {
    const botId = getEconomyBotId();
    const db = loadDB(botId);
    const user = getUser(db, jid);
    const released = settlePendingWithdrawalsForUser(user);
    if (released > 0) saveDB(db, false, botId);
    const activeNetwork = user.activeNetwork || 'Wistoria';
    const bankBalance = Math.max(0, Number(user.banks[activeNetwork] || 0));
    const pendingTitan = user.txMeta.Titan.pendingWithdrawals.reduce((sum, entry) => sum + entry.amount, 0);
    return {
        wallet: Math.max(0, Number(user.wallet || 0)),
        activeNetwork,
        bankBalance,
        banks: { ...user.banks },
        pendingTitan,
        totalAssets: totalAssetsOfUser(user)
    };
}

function setActiveNetwork(jid, network) {
    const botId = getEconomyBotId();
    const db = loadDB(botId);
    const user = getUser(db, jid);
    const profile = getRegisteredProfile(jid);
    const normalized = normalizeNetwork(network);
    if (!normalized) {
        return { ok: false, reason: 'unknown_network' };
    }
    const card = profile?.card || 'starter';
    if (!canAccessNetwork(card, normalized, { unlockedNetworks: getUnlockedNetworks(profile) })) {
        return { ok: false, reason: 'card_locked', card, network: normalized };
    }
    if (normalized === 'Glitch' && !profile?.blackCardUnlocked) {
        return { ok: false, reason: 'locked', network: normalized };
    }

    user.activeNetwork = normalized;
    saveDB(db, false, botId);
    mirrorUserStateAsync(botId, jid, user, 'set_active_network');
    setRegisteredNetwork(jid, normalized);
    return { ok: true, network: normalized };
}

function switchNetwork(jid, targetNetwork, opts = {}) {
    const botId = getEconomyBotId();
    const db = loadDB(botId);
    const user = getUser(db, jid);
    const profile = getRegisteredProfile(jid);
    settlePendingWithdrawalsForUser(user);

    const from = normalizeNetwork(user.activeNetwork || profile?.network || 'Wistoria') || 'Wistoria';
    const to = normalizeNetwork(targetNetwork);
    if (!to) return { ok: false, reason: 'unknown_network' };
    if (from === to) return { ok: false, reason: 'already_active', network: to };

    const card = profile?.card || 'starter';
    if (!canAccessNetwork(card, to, { unlockedNetworks: getUnlockedNetworks(profile) })) {
        return { ok: false, reason: 'card_locked', card, network: to };
    }
    if (to === 'Glitch' && !profile?.blackCardUnlocked) {
        return { ok: false, reason: 'locked', network: to };
    }

    const baseCost = getSwitchBaseCost(from, to);
    if (baseCost === null) {
        return { ok: false, reason: 'route_locked', from, to };
    }

    const now = Date.now();
    const switchRemaining = Number(user.txMeta.System.lastSwitchAt || 0) + SWITCH_COOLDOWN_MS - now;
    if (switchRemaining > 0) {
        return { ok: false, reason: 'switch_cooldown', remainingMs: switchRemaining, from, to };
    }

    const depositRemaining = Number(user.txMeta.System.lastDepositAt || 0) + SWITCH_BLOCK_AFTER_DEPOSIT_MS - now;
    if (depositRemaining > 0) {
        return { ok: false, reason: 'recent_deposit', remainingMs: depositRemaining, from, to };
    }

    let finalCost = baseCost;
    let riskMode = false;
    let riskDetail = '';
    if (opts.risk && to === 'Vortex') {
        riskMode = true;
        if (Math.random() < 0.5) {
            finalCost = 0;
            riskDetail = 'risk roll landed free switch';
        } else {
            finalCost = baseCost * 2;
            riskDetail = 'risk roll doubled the switch cost';
        }
    }

    const discountRate = getCardSwitchDiscount(card);
    const discountedCost = discountRate >= 1 ? 0 : Math.max(0, Math.floor(finalCost * (1 - discountRate)));
    if (user.wallet < discountedCost) {
        return {
            ok: false,
            reason: 'insufficient_wallet',
            wallet: user.wallet,
            cost: discountedCost,
            from,
            to
        };
    }

    user.wallet -= discountedCost;
    user.activeNetwork = to;
    user.txMeta.System.lastSwitchAt = now;
    saveDB(db, false, botId);
    mirrorUserStateAsync(botId, jid, user, 'switch_network');
    if (discountedCost > 0) {
        recordLedgerAsync({
            botId,
            jid,
            delta: -discountedCost,
            before: user.wallet + discountedCost,
            after: user.wallet,
            actorJid: jid,
            source: 'switch_network',
            category: 'network',
            meta: { from, to, baseCost, discountedCost, riskMode, riskDetail }
        });
    }
    setRegisteredNetwork(jid, to);

    return {
        ok: true,
        from,
        to,
        cost: discountedCost,
        baseCost,
        discountRate,
        card,
        wallet: user.wallet,
        riskMode,
        riskDetail
    };
}

function depositToBank(jid, amount, network) {
    const botId = getEconomyBotId();
    const db = loadDB(botId);
    const user = getUser(db, jid);
    const profile = getRegisteredProfile(jid);
    settlePendingWithdrawalsForUser(user);

    const targetNetwork = normalizeNetwork(network || user.activeNetwork) || user.activeNetwork || 'Wistoria';
    const info = NETWORKS[targetNetwork];
    if (!info) return { ok: false, reason: 'unknown_network' };
    const card = profile?.card || 'starter';
    if (!canAccessNetwork(card, targetNetwork, { unlockedNetworks: getUnlockedNetworks(profile) })) {
        return { ok: false, reason: 'card_locked', card, network: targetNetwork };
    }
    if (targetNetwork === 'Glitch' && !profile?.blackCardUnlocked) {
        return { ok: false, reason: 'locked', network: targetNetwork };
    }

    const rawAmount = Math.floor(Number(amount || 0));
    if (!rawAmount || rawAmount < 1) return { ok: false, reason: 'invalid_amount' };
    if (user.wallet < rawAmount) return { ok: false, reason: 'insufficient_wallet', wallet: user.wallet };

    const now = Date.now();
    if (info.depositCooldownMs > 0) {
        const remaining = Number(user.txMeta[targetNetwork]?.lastDepositAt || 0) + info.depositCooldownMs - now;
        if (remaining > 0) {
            return { ok: false, reason: 'deposit_cooldown', remainingMs: remaining, network: targetNetwork };
        }
    }

    const currentBank = Math.max(0, Number(user.banks[targetNetwork] || 0));
    let delta = 0;
    let detail = 'stable storage';

    if (targetNetwork === 'Neon') {
        const meta = user.txMeta.Neon;
        meta.recentTransactions = meta.recentTransactions.filter((stamp) => now - stamp <= info.spamWindowMs);
        const spamPenalty = meta.recentTransactions.length >= info.spamPenaltyAfter ? Math.floor(rawAmount * info.spamPenaltyRate) : 0;
        const bonus = Math.floor(rawAmount * info.depositBonusRate);
        delta = rawAmount + bonus - spamPenalty;
        detail = spamPenalty > 0
            ? `+${bonus} bonus, -${spamPenalty} spam fee`
            : `+${bonus} bonus`;
        meta.recentTransactions.push(now);
    } else if (targetNetwork === 'Vortex') {
        const win = Math.random() < info.vortexWinRate;
        if (win) {
            const bonus = Math.min(Math.floor(rawAmount * info.vortexWinBonusRate), info.vortexBonusCap);
            delta = rawAmount + bonus;
            detail = `vortex surge +${bonus}`;
        } else {
            const loss = Math.floor(rawAmount * info.vortexLossRate);
            delta = Math.max(0, rawAmount - loss);
            detail = `vortex instability -${loss}`;
        }
    } else if (targetNetwork === 'Titan') {
        delta = rawAmount;
        detail = 'cold storage locked';
        user.txMeta.Titan.lastDepositAt = now;
    } else if (targetNetwork === 'Glitch') {
        return { ok: false, reason: 'locked', network: targetNetwork };
    } else {
        delta = rawAmount;
    }

    if (currentBank + delta > info.maxLimit) {
        return { ok: false, reason: 'limit_exceeded', maxLimit: info.maxLimit, currentBank, network: targetNetwork };
    }

    user.wallet -= rawAmount;
    user.banks[targetNetwork] = currentBank + delta;
    user.activeNetwork = targetNetwork;
    user.txMeta.System.lastDepositAt = now;
    saveDB(db, false, botId);
    mirrorUserStateAsync(botId, jid, user, 'deposit_to_bank');
    recordLedgerAsync({
        botId,
        jid,
        delta: -rawAmount,
        before: user.wallet + rawAmount,
        after: user.wallet,
        actorJid: jid,
        source: 'deposit_to_bank',
        category: 'bank',
        meta: { network: targetNetwork, deposited: rawAmount, credited: delta, detail }
    });
    setRegisteredNetwork(jid, targetNetwork);

    return {
        ok: true,
        action: 'deposit',
        network: targetNetwork,
        deposited: rawAmount,
        credited: delta,
        wallet: user.wallet,
        bank: user.banks[targetNetwork],
        detail
    };
}

function withdrawFromBank(jid, amount, network) {
    const botId = getEconomyBotId();
    const db = loadDB(botId);
    const user = getUser(db, jid);
    const profile = getRegisteredProfile(jid);
    const released = settlePendingWithdrawalsForUser(user);

    const targetNetwork = normalizeNetwork(network || user.activeNetwork) || user.activeNetwork || 'Wistoria';
    const info = NETWORKS[targetNetwork];
    if (!info) return { ok: false, reason: 'unknown_network' };
    const card = profile?.card || 'starter';
    if (!canAccessNetwork(card, targetNetwork, { unlockedNetworks: getUnlockedNetworks(profile) })) {
        return { ok: false, reason: 'card_locked', card, network: targetNetwork };
    }

    const rawAmount = Math.floor(Number(amount || 0));
    if (!rawAmount || rawAmount < 1) return { ok: false, reason: 'invalid_amount' };
    const currentBank = Math.max(0, Number(user.banks[targetNetwork] || 0));
    if (currentBank < rawAmount) {
        if (released > 0) saveDB(db, false, botId);
        return { ok: false, reason: 'insufficient_bank', bank: currentBank, network: targetNetwork };
    }

    user.activeNetwork = targetNetwork;
    if (targetNetwork === 'Titan' && info.withdrawDelayMs > 0) {
        const now = Date.now();
        user.banks[targetNetwork] = currentBank - rawAmount;
        user.txMeta.Titan.pendingWithdrawals.push({
            amount: rawAmount,
            createdAt: now,
            readyAt: now + info.withdrawDelayMs
        });
        saveDB(db, { allowBankShrink: true }, botId);
        mirrorUserStateAsync(botId, jid, user, 'withdraw_pending');
        setRegisteredNetwork(jid, targetNetwork);
        return {
            ok: true,
            action: 'withdraw_pending',
            network: targetNetwork,
            amount: rawAmount,
            readyAt: now + info.withdrawDelayMs,
            bank: user.banks[targetNetwork],
            wallet: user.wallet
        };
    }

    user.banks[targetNetwork] = currentBank - rawAmount;
    const before = Math.max(0, Number(user.wallet || 0));
    addWallet(user, rawAmount);
    saveDB(db, { allowBankShrink: true }, botId);
    mirrorUserStateAsync(botId, jid, user, 'withdraw_from_bank');
    recordLedgerAsync({
        botId,
        jid,
        delta: rawAmount,
        before,
        after: user.wallet,
        actorJid: jid,
        source: 'withdraw_from_bank',
        category: 'bank',
        meta: { network: targetNetwork, amount: rawAmount }
    });
    setRegisteredNetwork(jid, targetNetwork);
    return {
        ok: true,
        action: 'withdraw',
        network: targetNetwork,
        amount: rawAmount,
        bank: user.banks[targetNetwork],
        wallet: user.wallet
    };
}

function calcChatReward(text) {
    if (!text || text.length < MIN_MSG_LENGTH) return 0;
    if (text.length >= 80) return 5;
    if (text.length >= 40) return 4;
    if (text.length >= 15) return 3;
    return 2;
}

function processChatReward(jid, text) {
    const botId = getEconomyBotId();
    const db = loadDB(botId);
    const user = getUser(db, jid);
    const now = Date.now();
    const today = todayStr();

    if (user.chatEarnDate !== today) {
        user.chatEarnedToday = 0;
        user.chatEarnDate = today;
    }
    if (now - (user.lastChat || 0) < CHAT_COOLDOWN_MS) return null;

    const normalized = String(text || '').trim();
    if (!normalized || normalized.length < MIN_MSG_LENGTH) return null;
    if (normalized === user.lastMessage) return null;
    if ((user.chatEarnedToday || 0) >= CHAT_DAILY_CAP) return null;

    const reward = calcChatReward(normalized);
    if (!reward) return null;

    user.chatEarnedToday = (user.chatEarnedToday || 0) + reward;
    user.lastChat = now;
    user.lastMessage = normalized;

    const todayNow = todayStr();
    ensureMissionDay(user, todayNow);
    addMissionProgress(user, 'chat15', 1);

    addWallet(user, reward); // FIXED: passive chat reward credits wallet
    saveDB(db, false, botId);
    mirrorUserStateAsync(botId, jid, user, 'process_chat_reward');
    recordLedgerAsync({
        botId,
        jid,
        delta: reward,
        before: user.wallet - reward,
        after: user.wallet,
        actorJid: jid,
        source: 'process_chat_reward',
        category: 'activity',
        meta: { textLength: normalized.length }
    });
    return reward;
}

function processMessageActivity(opts = {}) {
    const {
        jid,
        text = '',
        chatId = '',
        isCommand = false,
        isFromMe = false,
        isGroup = false,
        replyTargetJid = ''
    } = opts;

    if (!jid || isFromMe || isCommand) return null;

    const botId = getEconomyBotId();
    const db = loadDB(botId);
    const user = getUser(db, jid);
    const now = Date.now();
    const today = todayStr();
    ensureMissionDay(user, today);

    const normalized = String(text || '').trim();
    if (normalized.length >= MIN_MSG_LENGTH && normalized !== user.missionMeta.lastValidMessage) {
        addMissionProgress(user, 'chat15', 1);
        user.missionMeta.lastValidMessage = normalized;
    }

    if (user.chatEarnDate !== today) {
        user.chatEarnedToday = 0;
        user.chatEarnDate = today;
    }
    const canCooldown = now - (user.lastChat || 0) >= CHAT_COOLDOWN_MS;
    const notDuplicate = normalized && normalized !== user.lastMessage;
    const underCap = (user.chatEarnedToday || 0) < CHAT_DAILY_CAP;
    let chatReward = 0;
    let chatRewardBefore = Math.max(0, Number(user.wallet || 0));
    if (canCooldown && notDuplicate && underCap) {
        const reward = calcChatReward(normalized);
        if (reward > 0) {
            user.chatEarnedToday = (user.chatEarnedToday || 0) + reward;
            user.lastChat = now;
            user.lastMessage = normalized;
            addWallet(user, reward); // FIXED: message activity credits wallet
            chatReward = reward;
        }
    }

    let replyMission = null;
    if (replyTargetJid && String(replyTargetJid).trim() && String(replyTargetJid) !== String(jid)) {
        const target = String(replyTargetJid).split('@')[0].split(':')[0];
        if (target && !user.missionMeta.replyUsers.includes(target)) {
            user.missionMeta.replyUsers.push(target);
            replyMission = addMissionProgress(user, 'reply3', 1);
        }
    }

    let reviveMission = null;
    if (isGroup && chatId) {
        const last = Number(db.meta.chats[chatId]?.lastMessageAt || 0);
        if (last && now - last >= REVIVE_GAP_MS) {
            reviveMission = addMissionProgress(user, 'revive', 1);
        }
        db.meta.chats[chatId] = { lastMessageAt: now };
    }

    saveDB(db, false, botId);
    mirrorUserStateAsync(botId, jid, user, 'process_message_activity');
    if (chatReward > 0) {
        recordLedgerAsync({
            botId,
            jid,
            delta: chatReward,
            before: chatRewardBefore,
            after: user.wallet,
            actorJid: jid,
            source: 'process_message_activity',
            category: 'activity',
            meta: { chatId, isGroup: Boolean(isGroup) }
        });
    }
    return { chatReward, replyMission, reviveMission };
}

function claimDaily(jid) {
    const botId = getEconomyBotId();
    const db = loadDB(botId);
    const user = getUser(db, jid);
    const today = todayStr();

    if (user.lastDaily === today) return { already: true };

    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    if (user.lastDaily === yesterday) user.streak = (user.streak || 0) + 1;
    else user.streak = 1;

    const base = 500 + Math.floor(Math.random() * 1001);
    let streakBonus = 0;
    let rareDrop = null;
    if (user.streak >= 14) {
        streakBonus = Math.floor(base * 0.5);
        if (Math.random() < 0.05) rareDrop = 'rare';
    } else if (user.streak >= 7) {
        streakBonus = Math.floor(base * 0.25);
    } else if (user.streak >= 3) {
        streakBonus = Math.floor(base * 0.1);
    }
    const isWeekly = false;
    const weeklyBonus = 0;
    const total = base + streakBonus; // FIXED: real streak bonus payout

    const before = Math.max(0, Number(user.wallet || 0));
    addWallet(user, total);
    user.lastDaily = today;
    saveDB(db, false, botId);
    mirrorUserStateAsync(botId, jid, user, 'claim_daily');
    recordLedgerAsync({
        botId,
        jid,
        delta: total,
        before,
        after: user.wallet,
        actorJid: jid,
        source: 'claim_daily',
        category: 'daily',
        meta: { base, streakBonus, weeklyBonus, streak: user.streak, rareDrop }
    });
    awardRegistrationProgress(jid, total);

    return { total, base, streakBonus, weeklyBonus, streak: user.streak, isWeekly, rareDrop };
}

function getMissions(jid) {
    const botId = getEconomyBotId();
    const db = loadDB(botId);
    const user = getUser(db, jid);
    const today = todayStr();
    ensureMissionDay(user, today);
    saveDB(db, false, botId);
    mirrorUserStateAsync(botId, jid, user, 'get_missions');

    return Object.entries(MISSIONS).map(([key, mission]) => ({
        key,
        label: mission.label,
        goal: mission.goal,
        reward: mission.reward,
        progress: user.missions[key]?.progress || 0,
        completed: user.missions[key]?.completed || false
    }));
}

function progressMission(jid, missionKey) {
    const botId = getEconomyBotId();
    const db = loadDB(botId);
    const user = getUser(db, jid);
    ensureMissionDay(user, todayStr());
    const before = Math.max(0, Number(user.wallet || 0));
    const result = addMissionProgress(user, missionKey, 1);
    saveDB(db, false, botId);
    mirrorUserStateAsync(botId, jid, user, 'progress_mission');
    if (result?.rewarded) {
        recordLedgerAsync({
            botId,
            jid,
            delta: Number(result.reward || 0),
            before,
            after: user.wallet,
            actorJid: jid,
            source: 'progress_mission',
            category: 'mission',
            meta: { missionKey }
        });
    }
    return result;
}

function giveEventReward(jid, type = 'participate') {
    const rewards = { participate: 15, win: 50, rare: 100 };
    const amount = rewards[type] || 15;
    const balance = addBalance(jid, amount);
    return { amount, balance };
}

function getTopBalances(limit = 10) {
    const db = loadDB(getEconomyBotId());
    const users = db.users || {};
    const rows = Object.entries(users)
        .map(([jid, raw]) => {
            const user = migrateLegacyUser(raw || {}, jid);
            return { jid, balance: totalAssetsOfUser(user) };
        })
        .sort((a, b) => b.balance - a.balance);
    return rows.slice(0, Math.max(1, Number(limit || 10)));
}

function getUserRank(jid) {
    const db = loadDB(getEconomyBotId());
    const users = db.users || {};
    const rows = Object.entries(users)
        .map(([id, raw]) => {
            const user = migrateLegacyUser(raw || {}, id);
            return { jid: id, balance: totalAssetsOfUser(user) };
        })
        .sort((a, b) => b.balance - a.balance);
    const targetId = normalizeEconomyUserId(jid);
    const idx = rows.findIndex((entry) => normalizeEconomyUserId(entry.jid) === targetId);
    return { rank: idx >= 0 ? idx + 1 : null, total: rows.length, balance: rows[idx]?.balance || 0 };
}

module.exports = {
    getBalance,
    getBankBalance,
    getActiveNetwork,
    getEconomySnapshot,
    setActiveNetwork,
    switchNetwork,
    depositToBank,
    withdrawFromBank,
    addBalance,
    addBalanceAtomic,
    applyBalanceBatchAtomic,
    transferBalanceAtomic,
    processChatReward,
    processMessageActivity,
    claimDaily,
    getMissions,
    ensureSharedEconomyReady,
    reconcileBankStateFromLedger,
    reconcileEconomyStateFromLedger,
    progressMission,
    giveEventReward,
    getTopBalances,
    getUserRank
};
