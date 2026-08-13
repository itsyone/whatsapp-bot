const fs = require('fs');
const path = require('path');
const https = require('https');
const { addBalance } = require('./economy');
const {
    awardRegistrationProgress,
    getRegisteredProfile,
    addGlitchFragments,
    setDropBoost,
    consumeDropMagnet,
    addInventoryItem,
    accessItemKeyFromNetwork
} = require('./registrationStore');

let _getActiveMembers = null;
try {
    const topMembersModule = require('../commands/social/topmembers');
    _getActiveMembers = topMembersModule.getActiveMembers || null;
} catch {}

function getSqliteActiveCount(chatId) {
    if (!_getActiveMembers) return -1;
    try {
        return _getActiveMembers(chatId).length;
    } catch { return -1; }
}

const STATE_PATH = path.join(__dirname, '..', 'data', 'groupDrops.json');
const DROP_EXPIRE_MS = 6 * 60 * 1000;
const CHECK_MIN_MS = 10 * 60 * 1000;
const CHECK_MAX_MS = 20 * 60 * 1000;
const DROP_WINDOW_MIN_MS = 24 * 60 * 60 * 1000;
const DROP_WINDOW_MAX_MS = 24 * 60 * 60 * 1000;
const DROP_WINDOW_MAX_SPAWNS = 2;
const ACTIVITY_WINDOW_MS = 30 * 60 * 1000;
const ACTIVE_USER_WINDOW_MS = 24 * 60 * 60 * 1000;
const ACTIVE_USER_RECENT_MS = 24 * 60 * 60 * 1000;
const ACTIVE_USER_MIN_MESSAGES = 3;
const USER_SPAM_COOLDOWN_MS = 3 * 1000;
const GROUP_EVENT_BOOST_MS = 10 * 60 * 1000;
const USER_BOOST_MS = 10 * 60 * 1000;
const DROP_BURST_GUARD_MS = 45 * 1000;

const REWARD_IMAGES = {
    COMMON: 'https://files.catbox.moe/i78yqu.png',
    RARE: 'https://files.catbox.moe/10jlm8.png',
    EPIC: 'https://files.catbox.moe/4h2j1k.png',
    LEGENDARY: 'https://files.catbox.moe/jscx4v.png',
    GLITCH: 'https://files.catbox.moe/gqcmus.png'
};
const OPENED_REWARD_IMAGES = {
    COMMON: 'https://files.catbox.moe/wn00xl.png',
    RARE: 'https://files.catbox.moe/n745s1.png',
    EPIC: 'https://files.catbox.moe/y9iyl7.png',
    LEGENDARY: 'https://files.catbox.moe/gy23wg.png',
    GLITCH: 'https://files.catbox.moe/r8th32.png'
};

const thumbCache = new Map();
const RARITY_CHANCES = {
    COMMON: 60,
    RARE: 25,
    EPIC: 10,
    LEGENDARY: 4,
    GLITCH: 1
};


function readState() {
    try {
        if (!fs.existsSync(STATE_PATH)) {
            fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
            fs.writeFileSync(STATE_PATH, JSON.stringify({ groups: {} }, null, 2), 'utf8');
        }
        const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : { groups: {} };
    } catch {
        return { groups: {} };
    }
}

function writeState(state) {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function ensureGroup(state, chatId) {
    if (!state.groups) state.groups = {};
    if (!state.groups[chatId]) {
        state.groups[chatId] = {
            enabled: false,
            nextCheckAt: Date.now() + randomInt(CHECK_MIN_MS, CHECK_MAX_MS),
            windowStartedAt: Date.now(),
            windowEndsAt: Date.now() + randomInt(DROP_WINDOW_MIN_MS, DROP_WINDOW_MAX_MS),
            dropsSpawnedInWindow: 0,
            eventBoostUntil: 0,
            lastSpawnAt: 0,
            lastResolvedDrop: null,
            activityLog: [],
            users: {},
            activeDrop: null,
            pity: {
                commonStreak: 0,
                dropsSinceGlitch: 0
            },
            stats: {
                totalDrops: 0,
                totalClaims: 0
            }
        };
    }
    const group = state.groups[chatId];
    if (!Array.isArray(group.activityLog)) group.activityLog = [];
    if (!group.users || typeof group.users !== 'object') group.users = {};
    if (!Number.isFinite(Number(group.windowStartedAt || 0))) group.windowStartedAt = Date.now();
    if (!Number.isFinite(Number(group.windowEndsAt || 0))) {
        group.windowEndsAt = Number(group.windowStartedAt || Date.now()) + randomInt(DROP_WINDOW_MIN_MS, DROP_WINDOW_MAX_MS);
    }
    if (!Number.isFinite(Number(group.dropsSpawnedInWindow || 0))) group.dropsSpawnedInWindow = 0;
    if (!group.pity || typeof group.pity !== 'object') group.pity = { commonStreak: 0, dropsSinceGlitch: 0 };
    if (!group.stats || typeof group.stats !== 'object') group.stats = { totalDrops: 0, totalClaims: 0 };
    if (!group.lastResolvedDrop || typeof group.lastResolvedDrop !== 'object') group.lastResolvedDrop = null;
    return group;
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function nextCheckAt(now = Date.now()) {
    return now + randomInt(CHECK_MIN_MS, CHECK_MAX_MS);
}

function normalizeActivityJid(value) {
    const raw = String(value || '').trim();
    if (raw.includes('@lid')) {
        return raw.split(':')[0].includes('@') ? raw.split(':')[0] : raw;
    }
    const digits = raw.split('@')[0].split(':')[0].replace(/\D/g, '');
    return digits ? `${digits}@s.whatsapp.net` : '';
}

function resetDropWindow(group, now = Date.now()) {
    group.windowStartedAt = now;
    group.windowEndsAt = now + randomInt(DROP_WINDOW_MIN_MS, DROP_WINDOW_MAX_MS);
    group.dropsSpawnedInWindow = 0;
}

function ensureDropWindow(group, now = Date.now()) {
    if (now >= Number(group.windowEndsAt || 0)) {
        resetDropWindow(group, now);
    }
}

function pruneGroup(group, now = Date.now()) {
    ensureDropWindow(group, now);
    group.activityLog = (group.activityLog || []).filter((entry) => now - Number(entry.at || 0) <= ACTIVITY_WINDOW_MS);

    for (const [jid, user] of Object.entries(group.users || {})) {
        user.messageHistory = Array.isArray(user.messageHistory)
            ? user.messageHistory.filter((stamp) => now - Number(stamp || 0) <= ACTIVE_USER_WINDOW_MS)
            : [];
        user.activeQualified = user.messageHistory.length >= ACTIVE_USER_MIN_MESSAGES;
        user.activeNow = Boolean(user.activeQualified && (now - Number(user.lastAt || 0) <= ACTIVE_USER_RECENT_MS));

        if (
            now - Number(user.lastAt || 0) > ACTIVE_USER_WINDOW_MS &&
            user.messageHistory.length === 0
        ) {
            delete group.users[jid];
        }
    }

    if (group.activeDrop && Number(group.activeDrop.expiresAt || 0) <= now) {
        group.lastResolvedDrop = {
            reason: 'expired',
            at: Number(group.activeDrop.expiresAt || now)
        };
        group.activeDrop = null;
    }
    if (Number(group.eventBoostUntil || 0) <= now) {
        group.eventBoostUntil = 0;
    }
}

function getActivityStats(group, now = Date.now(), chatId = '') {
    const recent = (group.activityLog || []).filter((entry) => now - Number(entry.at || 0) <= ACTIVITY_WINDOW_MS);
    const score = recent.reduce((sum, entry) => sum + Number(entry.weight || 0), 0);
    const inMemoryActive = Object.values(group.users || {}).filter((user) => Boolean(user?.activeNow)).length;
    const sqliteActive = chatId ? getSqliteActiveCount(chatId) : -1;
    const activeUsers = sqliteActive >= 0 ? Math.max(sqliteActive, inMemoryActive) : inMemoryActive;
    return {
        activityScore: Number(score.toFixed(2)),
        activeUsers
    };
}

function getActiveEffectSummary(group, now = Date.now()) {
    const users = Object.entries(group.users || {})
        .filter(([, user]) => Boolean(user?.activeNow))
        .map(([jid]) => ({ jid, profile: getRegisteredProfile(jid) }))
        .filter((entry) => entry.profile);

    const magnetUsers = users.filter((entry) => Boolean(entry.profile?.effects?.dropMagnetReady)).map((entry) => entry.jid);
    const glitchBoostUsers = users.filter((entry) => Number(entry.profile?.glitchFragments || 0) >= 5).map((entry) => entry.jid);

    return {
        magnetUsers,
        glitchBoostUsers
    };
}

function normalizeWeight(text, userState, now) {
    const normalized = String(text || '').trim().toLowerCase();
    let weight = 1;

    if (!normalized) {
        weight = 0.2;
    }
    if (normalized && normalized === String(userState.lastText || '')) {
        weight *= 0.35;
    }
    if (now - Number(userState.lastAt || 0) < USER_SPAM_COOLDOWN_MS) {
        weight *= 0.3;
        userState.spamChain = Number(userState.spamChain || 0) + 1;
    } else {
        userState.spamChain = 0;
    }
    if (Number(userState.spamChain || 0) >= 3) {
        weight *= 0.5;
    }
    if (normalized.length >= 24) {
        weight *= 1.15;
    }

    return Math.max(0.1, Number(weight.toFixed(2)));
}

function chooseRarity() {
    const common = RARITY_CHANCES.COMMON;
    const rare = RARITY_CHANCES.RARE;
    const epic = RARITY_CHANCES.EPIC;
    const legendary = RARITY_CHANCES.LEGENDARY;
    const glitch = RARITY_CHANCES.GLITCH;
    const roll = Math.random() * 100;
    let edge = common;
    if (roll < edge) return 'COMMON';
    edge += rare;
    if (roll < edge) return 'RARE';
    edge += epic;
    if (roll < edge) return 'EPIC';
    edge += legendary;
    if (roll < edge) return 'LEGENDARY';
    return 'GLITCH';
}

function createReward(rarity) {
    if (rarity === 'COMMON') {
        return {
            rarity,
            cash: 180,
            xp: 22,
            itemRewards: Math.random() < 0.35 ? [{ key: 'dropMagnet', amount: 1 }] : []
        };
    }
    if (rarity === 'RARE') {
        return {
            rarity,
            cash: 2400,
            xp: 210,
            networkUnlock: 'Neon',
            itemRewards: [{ key: 'xpBoost', amount: 1 }]
        };
    }
    if (rarity === 'EPIC') {
        return {
            rarity,
            cash: 6000,
            xp: 700,
            boostMs: USER_BOOST_MS,
            itemRewards: [{ key: 'unlockToken', amount: 1 }]
        };
    }
    if (rarity === 'LEGENDARY') {
        return {
            rarity,
            cash: 25000,
            xp: 4000,
            networkUnlock: 'Titan',
            itemRewards: [{ key: 'vaultKey', amount: 1 }]
        };
    }

    const reward = {
        rarity,
        cash: randomInt(10_000, 100_000),
        xp: randomInt(0, 5_000),
        networkUnlock: ['Neon', 'Vortex', 'Titan', 'Glitch'][randomInt(0, 3)],
        fragments: randomInt(1, 4),
        itemRewards: Math.random() < 0.5 ? [{ key: Math.random() < 0.5 ? 'xpBoost' : 'dropMagnet', amount: 1 }] : [],
        mode: 'stable'
    };

    const roll = Math.random();
    if (roll < 0.12) {
        reward.mode = 'corrupt';
        reward.cash = 0;
        reward.xp = 0;
    } else if (roll < 0.34) {
        reward.mode = Math.random() < 0.5 ? 'double' : 'nothing';
        if (reward.mode === 'double') {
            reward.cash *= 2;
            reward.xp *= 2;
            reward.fragments += 1;
        } else {
            reward.cash = 0;
            reward.xp = 0;
        }
    }

    return reward;
}

function maybeStartBoostEvent(group, now) {
    if (group.eventBoostUntil > now) return false;
    if (Math.random() < 0.08) {
        group.eventBoostUntil = now + GROUP_EVENT_BOOST_MS;
        return true;
    }
    return false;
}

function maybeSpawnDrop(chatId) {
    const state = readState();
    const group = ensureGroup(state, chatId);
    const now = Date.now();
    pruneGroup(group, now);

    if (!group.enabled) {
        writeState(state);
        return null;
    }
    if (group.activeDrop) {
        writeState(state);
        return null;
    }
    if (now - Number(group.lastSpawnAt || 0) < DROP_BURST_GUARD_MS) {
        writeState(state);
        return null;
    }
    if (now < Number(group.nextCheckAt || 0)) {
        writeState(state);
        return null;
    }
    if (Number(group.dropsSpawnedInWindow || 0) >= DROP_WINDOW_MAX_SPAWNS) {
        group.nextCheckAt = Math.max(Number(group.windowEndsAt || now), now + 60_000);
        writeState(state);
        return null;
    }

    const stats = getActivityStats(group, now, chatId);
    const effectSummary = getActiveEffectSummary(group, now);
    const canSpawnFromPeople = stats.activeUsers >= 2;
    const activityRatio = Math.min(0.45, stats.activityScore / 40);
    const userRatio = Math.min(0.18, Math.max(0, stats.activeUsers - 2) * 0.03);
    const eventBonus = group.eventBoostUntil > now ? 0.2 : 0;
    const magnetBonus = effectSummary.magnetUsers.length > 0 ? 0.08 : 0;
    const spawnChance = 0.04 + activityRatio + userRatio + eventBonus + magnetBonus;
    group.nextCheckAt = nextCheckAt(now);

    if (!canSpawnFromPeople || stats.activityScore < 8 || Math.random() > spawnChance) {
        writeState(state);
        return null;
    }

    const boostStarted = maybeStartBoostEvent(group, now);
    const rarity = chooseRarity();
    const reward = createReward(rarity);
    group.activeDrop = {
        spawnedAt: now,
        expiresAt: now + DROP_EXPIRE_MS,
        rarity,
        reward,
        claimedBy: '',
        claimAt: 0,
        activitySnapshot: stats
    };
    group.lastSpawnAt = now;
    group.dropsSpawnedInWindow = Number(group.dropsSpawnedInWindow || 0) + 1;
    group.stats.totalDrops = Number(group.stats.totalDrops || 0) + 1;
    effectSummary.magnetUsers.forEach((jid) => consumeDropMagnet(jid));
    writeState(state);

    return {
        rarity,
        reward,
        expiresAt: group.activeDrop.expiresAt,
        activityScore: stats.activityScore,
        activeUsers: stats.activeUsers,
        boostStarted,
        boostUntil: group.eventBoostUntil
    };
}

function forceSpawnDrop(chatId, opts = {}) {
    const state = readState();
    const group = ensureGroup(state, chatId);
    const now = Date.now();
    pruneGroup(group, now);

    if (group.activeDrop) {
        return {
            ok: false,
            reason: 'active_exists',
            expiresAt: group.activeDrop.expiresAt,
            rarity: group.activeDrop.rarity
        };
    }

    const rarity = String(opts.rarity || '').trim().toUpperCase();
    const finalRarity = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'GLITCH'].includes(rarity)
        ? rarity
        : chooseRarity();
    const reward = createReward(finalRarity);
    const stats = getActivityStats(group, now, chatId);

    group.enabled = true;
    group.activeDrop = {
        spawnedAt: now,
        expiresAt: now + DROP_EXPIRE_MS,
        rarity: finalRarity,
        reward,
        claimedBy: '',
        claimAt: 0,
        activitySnapshot: stats
    };
    group.lastSpawnAt = now;
    group.dropsSpawnedInWindow = Number(group.dropsSpawnedInWindow || 0) + 1;
    group.nextCheckAt = nextCheckAt(now);
    group.stats.totalDrops = Number(group.stats.totalDrops || 0) + 1;
    writeState(state);

    return {
        ok: true,
        rarity: finalRarity,
        reward,
        expiresAt: group.activeDrop.expiresAt,
        activityScore: stats.activityScore,
        activeUsers: stats.activeUsers,
        boostStarted: false,
        boostUntil: group.eventBoostUntil
    };
}

function observeGroupActivity({ chatId, senderId, text = '', isGroup = false, isFromMe = false }) {
    if (!isGroup || isFromMe || !chatId || !senderId) return null;

    const state = readState();
    const group = ensureGroup(state, chatId);
    const now = Date.now();
    pruneGroup(group, now);

    const normalizedSenderId = normalizeActivityJid(senderId);
    if (!normalizedSenderId) return null;

    const userState = group.users[normalizedSenderId] || { lastAt: 0, lastText: '', spamChain: 0, messageHistory: [] };
    const weight = normalizeWeight(text, userState, now);
    userState.lastAt = now;
    userState.lastText = String(text || '').trim().toLowerCase().slice(0, 160);
    userState.messageHistory = Array.isArray(userState.messageHistory) ? userState.messageHistory : [];
    userState.messageHistory.push(now);
    userState.messageHistory = userState.messageHistory.filter((stamp) => now - Number(stamp || 0) <= ACTIVE_USER_WINDOW_MS);
    userState.activeQualified = userState.messageHistory.length >= ACTIVE_USER_MIN_MESSAGES;
    userState.activeNow = Boolean(userState.activeQualified && (now - Number(userState.lastAt || 0) <= ACTIVE_USER_RECENT_MS));
    group.users[normalizedSenderId] = userState;
    group.activityLog.push({ user: normalizedSenderId, at: now, weight });
    writeState(state);

    return maybeSpawnDrop(chatId);
}

function setDropsEnabled(chatId, enabled) {
    const state = readState();
    const group = ensureGroup(state, chatId);
    const now = Date.now();
    pruneGroup(group, now);
    group.enabled = Boolean(enabled);
    ensureDropWindow(group, now);
    group.nextCheckAt = nextCheckAt(now);
    writeState(state);
    return group;
}

function getDropStatus(chatId) {
    const state = readState();
    const group = ensureGroup(state, chatId);
    const now = Date.now();
    pruneGroup(group, now);
    writeState(state);
    const stats = getActivityStats(group, now, chatId);
    return {
        enabled: Boolean(group.enabled),
        nextCheckInMs: Math.max(0, Number(group.nextCheckAt || 0) - now),
        windowEndsInMs: Math.max(0, Number(group.windowEndsAt || 0) - now),
        dropsRemainingInWindow: Math.max(0, DROP_WINDOW_MAX_SPAWNS - Number(group.dropsSpawnedInWindow || 0)),
        eventBoostInMs: Math.max(0, Number(group.eventBoostUntil || 0) - now),
        activityScore: stats.activityScore,
        activeUsers: stats.activeUsers,
        activeDrop: group.activeDrop
            ? {
                expiresInMs: Math.max(0, Number(group.activeDrop.expiresAt || 0) - now),
                claimedBy: group.activeDrop.claimedBy || '',
                rarity: group.activeDrop.rarity
            }
            : null
    };
}

function formatDuration(ms) {
    const total = Math.max(1, Math.ceil(Number(ms || 0) / 1000));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    if (mins < 1) return `${secs}s`;
    return secs ? `${mins}m ${secs}s` : `${mins}m`;
}

function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return fetchBuffer(res.headers.location).then(resolve).catch(reject);
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function getRewardImage(rarity) {
    const key = String(rarity || '').toUpperCase();
    const url = REWARD_IMAGES[key];
    if (!url) return null;
    if (!thumbCache.has(url)) {
        thumbCache.set(url, await fetchBuffer(url).catch(() => null));
    }
    return thumbCache.get(url) || null;
}

async function getOpenedRewardImage(rarity) {
    const key = String(rarity || '').toUpperCase();
    const url = OPENED_REWARD_IMAGES[key];
    if (!url) return null;
    if (!thumbCache.has(url)) {
        thumbCache.set(url, await fetchBuffer(url).catch(() => null));
    }
    return thumbCache.get(url) || null;
}

function buildDropCard(text, thumb, rarity = '') {
    const title = String(rarity || '').trim().toUpperCase() || 'DROP';
    return {
        text,
        contextInfo: {
            externalAdReply: {
                title: `${title} DROP`,
                body: 'limited time reward',
                mediaType: 1,
                mediaUrl: '',
                renderLargerThumbnail: false,
                showAdAttribution: false,
                sourceUrl: '',
                ...(thumb ? { thumbnail: thumb } : {})
            }
        }
    };
}

function getBoostMultiplier(profile) {
    return Number(profile?.dropBoostUntil || 0) > Date.now() ? 1.15 : 1;
}

function computeAppliedReward(jid, reward) {
    const profile = getRegisteredProfile(jid);
    const walletMultiplier = getBoostMultiplier(profile);
    const xpMultiplier = Number(profile?.effects?.xpBoostUntil || 0) > Date.now() ? 2 : 1;
    return {
        cash: Math.max(0, Math.floor(Number(reward.cash || 0) * walletMultiplier)),
        xp: Math.max(0, Math.floor(Number(reward.xp || 0) * xpMultiplier)),
        unlockedNetwork: String(reward.networkUnlock || ''),
        fragments: Number(reward.fragments || 0),
        itemRewards: Array.isArray(reward.itemRewards) ? reward.itemRewards.map((entry) => ({
            key: String(entry?.key || ''),
            amount: Math.max(0, Math.floor(Number(entry?.amount || 0)))
        })).filter((entry) => entry.key && entry.amount > 0) : [],
        boostApplied: walletMultiplier > 1 || xpMultiplier > 1,
        xpBoostApplied: xpMultiplier > 1,
        boostGrantedMs: Number(reward.boostMs || 0),
        mode: reward.mode || 'stable'
    };
}

function applyReward(jid, reward, precomputed = null) {
    const applied = precomputed || computeAppliedReward(jid, reward);
    const cash = applied.cash;
    const xp = applied.xp;

    if (cash > 0) addBalance(jid, cash, { awardXp: false });
    if (xp > 0) awardRegistrationProgress(jid, xp);

    let unlockedNetwork = '';
    if (reward.networkUnlock) {
        const accessItemKey = accessItemKeyFromNetwork(reward.networkUnlock);
        if (accessItemKey) {
            addInventoryItem(jid, accessItemKey, 1);
            unlockedNetwork = reward.networkUnlock;
        }
    }

    if (reward.fragments) {
        addGlitchFragments(jid, reward.fragments);
    }

    if (reward.boostMs) {
        setDropBoost(jid, reward.boostMs);
    }

    for (const item of applied.itemRewards || []) {
        addInventoryItem(jid, item.key, item.amount);
    }

    return { ...applied, unlockedNetwork };
}

function claimGroupDrop(chatId, senderId) {
    const state = readState();
    const group = ensureGroup(state, chatId);
    const now = Date.now();
    pruneGroup(group, now);

    if (!group.activeDrop) {
        if (group.lastResolvedDrop && now - Number(group.lastResolvedDrop.at || 0) <= DROP_EXPIRE_MS) {
            writeState(state);
            return {
                ok: false,
                reason: group.lastResolvedDrop.reason || 'none',
                claimedBy: group.lastResolvedDrop.claimedBy || ''
            };
        }
        writeState(state);
        return { ok: false, reason: 'none' };
    }

    if (group.activeDrop.claimedBy) {
        const claimedBy = group.activeDrop.claimedBy;
        writeState(state);
        return { ok: false, reason: 'claimed', claimedBy };
    }

    const drop = group.activeDrop;
    const applied = computeAppliedReward(senderId, drop.reward);
    drop.claimedBy = senderId;
    drop.claimAt = now;
    const appliedFinal = applyReward(senderId, drop.reward, applied);
    drop.claimedBy = senderId;
    drop.claimAt = now;
    group.stats.totalClaims = Number(group.stats.totalClaims || 0) + 1;
    if (drop.rarity === 'COMMON') {
        group.pity.commonStreak = Number(group.pity.commonStreak || 0) + 1;
        group.pity.dropsSinceGlitch = Number(group.pity.dropsSinceGlitch || 0) + 1;
    } else {
        group.pity.commonStreak = 0;
        group.pity.dropsSinceGlitch = drop.rarity === 'GLITCH' ? 0 : Number(group.pity.dropsSinceGlitch || 0) + 1;
    }
    group.lastResolvedDrop = {
        reason: 'claimed',
        at: now,
        claimedBy: senderId
    };
    group.activeDrop = null;
    writeState(state);

    return {
        ok: true,
        rarity: drop.rarity,
        reward: drop.reward,
        applied: appliedFinal
    };
}

function buildSpawnText(event) {
    const rarity = String(event?.rarity || '').toUpperCase();
    const titleMap = {
        COMMON: '🟢 *COMMON DROP* 🎁',
        RARE: '🔵 *RARE DROP* 🎁',
        EPIC: '🟣 *EPIC DROP* 🎁',
        LEGENDARY: '🟡 *LEGENDARY DROP* 🎁',
        GLITCH: '🔴 *GLITCH DROP* 🎁'
    };
    const lines = [
        titleMap[rarity] || '🎁 *DROP*',
        '',
        '> limited time',
        '> `.claim`'
    ];
    if (event.boostStarted && event.boostUntil) {
        lines.push('');
        lines.push('⚡ *DROP BOOST ACTIVE*');
    }
    return lines.join('\n');
}

function buildStatusText(status) {
    return [
        '🎲 *DROP STATUS*',
        '',
        `> enabled: ${status.enabled ? 'ON' : 'OFF'}`,
        `> next check: ${formatDuration(status.nextCheckInMs)}`,
        `> window reset: ${formatDuration(status.windowEndsInMs)}`,
        `> drops left: ${status.dropsRemainingInWindow}/${DROP_WINDOW_MAX_SPAWNS}`,
        `> active users: ${status.activeUsers}`,
        `> activity score: ${status.activityScore}`,
        `> group boost: ${status.eventBoostInMs > 0 ? formatDuration(status.eventBoostInMs) : 'inactive'}`,
        `> rarity %: C${RARITY_CHANCES.COMMON} R${RARITY_CHANCES.RARE} E${RARITY_CHANCES.EPIC} L${RARITY_CHANCES.LEGENDARY} G${RARITY_CHANCES.GLITCH}`,
        `> active drop: ${status.activeDrop ? `yes • expires in ${formatDuration(status.activeDrop.expiresInMs)}` : 'none'}`
    ].join('\n');
}

function mentionFromJid(jid) {
    return `@${String(jid || '').split('@')[0].split(':')[0]}`;
}

function buildRevealText(result, senderId) {
    const reward = result.applied;
    if (result.rarity === 'COMMON') {
        return [
            '🟢 *COMMON REWARD* •',
            '',
            `> +$${reward.cash.toLocaleString()} 💵`,
            `> +${reward.xp.toLocaleString()} XP ⚡`
        ].join('\n');
    }
    if (result.rarity === 'RARE') {
        return [
            '🔵 *RARE REWARD* ✦',
            '',
            `> +$${reward.cash.toLocaleString()} 💰`,
            `> +${reward.xp.toLocaleString()} XP ⚡`,
            `> 🎒 ${reward.unlockedNetwork || 'Neon'} access item ×1`
        ].join('\n');
    }
    if (result.rarity === 'EPIC') {
        return [
            '🟣 *EPIC REWARD* ❖',
            '',
            `> +$${reward.cash.toLocaleString()} 🪙`,
            `> +${reward.xp.toLocaleString()} XP ⚡`,
            '> ⏩ boost enabled'
        ].join('\n');
    }
    if (result.rarity === 'LEGENDARY') {
        return [
            '🟡 *LEGENDARY REWARD* ✶',
            '',
            `> +$${reward.cash.toLocaleString()} 💰`,
            `> +${reward.xp.toLocaleString()} XP ⚡`,
            `> 🎒 ${reward.unlockedNetwork || 'Titan'} access item ×1`
        ].join('\n');
    }

    const lines = [
        'G̴L̷I̶T̸C̴H̶ ̷R̶E̷W̸A̶R̵D̴',
        '',
        `> claimer: ${mentionFromJid(senderId)}`,
        `> +$${reward.cash.toLocaleString()} 🩸`,
        `> +${reward.xp.toLocaleString()} XP ⚡`,
        `> ${reward.unlockedNetwork ? `🎒 ${reward.unlockedNetwork} access item ×1` : '⚠ system unstable'}`,
        `> fragments: ${reward.fragments || 0}`
    ];

    if (reward.mode === 'corrupt') {
        lines.push('> ❌ corrupted to $0');
    } else if (reward.mode === 'double') {
        lines.push('> ⚡ DOUBLE trigger');
    } else if (reward.mode === 'nothing') {
        lines.push('> 💀 NOTHING trigger');
    }
    if (reward.boostApplied) {
        lines.push('> boost multiplier applied');
    }

    return lines.join('\n');
}

function buildRevealTextV2(result, senderId) {
    const reward = result.applied;
    const itemLines = (reward.itemRewards || []).map((item) => {
        if (item.key === 'dropMagnet') return `> 🧲 drop magnet ×${item.amount}`;
        if (item.key === 'xpBoost') return `> ⚡ xp boost ×${item.amount}`;
        if (item.key === 'unlockToken') return `> 🔓 unlock token ×${item.amount}`;
        if (item.key === 'vaultKey') return `> 🗝 vault key ×${item.amount}`;
        return '';
    }).filter(Boolean);

    if (result.rarity === 'COMMON') {
        return [
            '🟢 *COMMON REWARD* •',
            '',
            `> +$${reward.cash.toLocaleString()} 💵`,
            `> +${reward.xp.toLocaleString()} XP ⚡`,
            ...itemLines
        ].join('\n');
    }
    if (result.rarity === 'RARE') {
        return [
            '🔵 *RARE REWARD* ✦',
            '',
            `> +$${reward.cash.toLocaleString()} 💰`,
            `> +${reward.xp.toLocaleString()} XP ⚡`,
            `> 🎒 ${reward.unlockedNetwork || 'Neon'} access item ×1`,
            ...itemLines
        ].join('\n');
    }
    if (result.rarity === 'EPIC') {
        return [
            '🟣 *EPIC REWARD* ❖',
            '',
            `> +$${reward.cash.toLocaleString()} 🪙`,
            `> +${reward.xp.toLocaleString()} XP ⚡`,
            '> ⏩ boost enabled',
            ...itemLines
        ].join('\n');
    }
    if (result.rarity === 'LEGENDARY') {
        return [
            '🟡 *LEGENDARY REWARD* ✶',
            '',
            `> +$${reward.cash.toLocaleString()} 💰`,
            `> +${reward.xp.toLocaleString()} XP ⚡`,
            `> 🎒 ${reward.unlockedNetwork || 'Titan'} access item ×1`,
            ...itemLines
        ].join('\n');
    }

    const lines = [
        'G̴L̷I̶T̸C̴H̶ ̷R̶E̷W̸A̶R̵D̴',
        '',
        `> claimer: ${mentionFromJid(senderId)}`,
        `> +$${reward.cash.toLocaleString()} 🩸`,
        `> +${reward.xp.toLocaleString()} XP ⚡`,
        `> ${reward.unlockedNetwork ? `🎒 ${reward.unlockedNetwork} access item ×1` : '⚠ system unstable'}`,
        `> fragments: ${reward.fragments || 0}`,
        ...itemLines
    ];

    if (reward.mode === 'corrupt') {
        lines.push('> ❌ corrupted to $0');
    } else if (reward.mode === 'double') {
        lines.push('> ⚡ DOUBLE trigger');
    } else if (reward.mode === 'nothing') {
        lines.push('> 💀 NOTHING trigger');
    }
    if (reward.boostApplied) {
        lines.push('> boost multiplier applied');
    }

    return lines.join('\n');
}

module.exports = {
    observeGroupActivity,
    forceSpawnDrop,
    setDropsEnabled,
    getDropStatus,
    claimGroupDrop,
    buildSpawnText,
    buildStatusText,
    buildRevealText: buildRevealTextV2,
    getRewardImage,
    getOpenedRewardImage,
    buildDropCard,
    formatDuration,
    DROP_EXPIRE_MS
};
