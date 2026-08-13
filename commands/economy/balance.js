const https = require('https');
const { getEconomySnapshot, claimDaily, getMissions } = require('../../lib/economy');
const { getRegisteredProfile } = require('../../lib/registrationStore');

const THUMB_URL = 'https://i.ibb.co/bgtdKvvk/jpeg-optimizer-Chat-GPT-Image-Mar-30-2026-01-05-11-AM-Photoroom.png';
const DAILY_THUMB_URL = 'https://files.catbox.moe/oly9gl.png';
let thumbCache = null;
let dailyThumbCache = null;
const NETWORK_THUMBS = {
    wistoria: 'https://files.catbox.moe/1aydkb.png',
    eclipse: 'https://files.catbox.moe/1aydkb.png',
    vortex: 'https://files.catbox.moe/ht7htx.png',
    titan: 'https://files.catbox.moe/8lwyau.png',
    glitch: 'https://files.catbox.moe/3uu8zz.png',
    neon: 'https://files.catbox.moe/v5gnqo.png'
};
const WISTORIA_RANK_THUMBS = {
    iron: 'https://files.catbox.moe/w7rkju.png',
    bronze: 'https://files.catbox.moe/2q2zxv.png',
    silver: 'https://files.catbox.moe/91427b.png',
    gold: 'https://files.catbox.moe/yftwvo.png',
    platinum: 'https://files.catbox.moe/riamgj.png',
    diamond: 'https://files.catbox.moe/64pj5y.png',
    master: 'https://files.catbox.moe/m6z5uz.png',
    grandmaster: 'https://files.catbox.moe/m6z5uz.png',
    challenger: 'https://files.catbox.moe/0fw1rn.png'
};
const networkThumbCache = new Map();
const displayNameCache = new Map();
const BALANCE_THUMB_TIMEOUT_MS = 4500;
const DISPLAY_NAME_TTL_MS = 5 * 60 * 1000;

function fetchBuffer(url, timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return fetchBuffer(res.headers.location, timeoutMs).then(resolve).catch(reject);
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => {
            req.destroy();
            reject(new Error('fetchBuffer timed out'));
        });
    });
}

async function getThumb() {
    if (!thumbCache) thumbCache = await fetchBuffer(THUMB_URL).catch(() => null);
    return thumbCache;
}

async function getDailyThumb() {
    if (!dailyThumbCache) dailyThumbCache = await fetchBuffer(DAILY_THUMB_URL).catch(() => null);
    return dailyThumbCache;
}

async function getNetworkThumb(network) {
    const key = String(network || '').trim().toLowerCase();
    const url = NETWORK_THUMBS[key] || THUMB_URL;
    if (!networkThumbCache.has(url)) {
        networkThumbCache.set(url, await fetchBuffer(url).catch(() => null));
    }
    return networkThumbCache.get(url) || null;
}

function pickRankLabel(level, totalXpEarned) {
    const safeLevel = Math.max(0, Number(level || 0));
    const safeTotalXp = Math.max(0, Number(totalXpEarned || 0));
    const score = (safeLevel * 1000) + safeTotalXp;

    if (score >= 32000) return 'challenger';
    if (score >= 24000) return 'grandmaster';
    if (score >= 17000) return 'master';
    if (score >= 11000) return 'diamond';
    if (score >= 7000) return 'platinum';
    if (score >= 4000) return 'gold';
    if (score >= 1800) return 'silver';
    if (score >= 600) return 'bronze';
    return 'iron';
}

function formatRankLabel(rank) {
    const text = String(rank || 'iron').trim().toLowerCase();
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Iron';
}

async function getDisplayName(sock, jid, fallback = 'User') {
    const preferred = String(fallback || '').trim();
    if (preferred) return preferred;
    const cacheKey = String(jid || '').trim();
    const cached = displayNameCache.get(cacheKey);
    if (cached && (Date.now() - cached.at) < DISPLAY_NAME_TTL_MS) {
        return cached.value; // FIXED: cache balance display-name lookups
    }

    try {
        const name = await sock.getName(jid);
        if (name) {
            const value = String(name).trim();
            displayNameCache.set(cacheKey, { value, at: Date.now() }); // FIXED: cache resolved balance display name
            return value;
        }
    } catch {}
    displayNameCache.set(cacheKey, { value: 'User', at: Date.now() }); // FIXED: cache balance name fallback
    return 'User';
}

async function getBalanceThumb(senderId, network) {
    const networkKey = String(network || '').trim().toLowerCase();
    if (networkKey !== 'wistoria' && networkKey !== 'eclipse') {
        return getNetworkThumb(networkKey);
    }

    const profile = getRegisteredProfile(senderId);
    const rankKey = pickRankLabel(profile?.level || 0, profile?.totalXpEarned || 0);
    const url = WISTORIA_RANK_THUMBS[rankKey] || NETWORK_THUMBS.wistoria;
    if (!networkThumbCache.has(url)) {
        networkThumbCache.set(url, await fetchBuffer(url).catch(() => null));
    }
    return networkThumbCache.get(url) || null;
}

function card(lines, thumb, mentions = [], title = 'User', body = 'Iron') {
    const payload = {
        text: lines.join('\n'),
        mentions
    };

    if (thumb) {
        payload.contextInfo = {
            externalAdReply: {
                title,
                body,
                mediaType: 1,
                mediaUrl: '',
                renderLargerThumbnail: false,
                showAdAttribution: false,
                thumbnail: thumb
            }
        };
    }

    return payload;
}

async function withTimeout(promise, timeoutMs) {
    return Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
    ]); // FIXED: fast balance thumbnail fallback
}

async function balanceCommand(sock, chatId, message, senderId) {
    try {
        const snapshot = getEconomySnapshot(senderId);
        const profile = getRegisteredProfile(senderId);
        const thumb = await withTimeout(getBalanceThumb(senderId, snapshot.activeNetwork), BALANCE_THUMB_TIMEOUT_MS);
        const rankLabel = formatRankLabel(pickRankLabel(profile?.level || 0, profile?.totalXpEarned || 0));
        const title = await getDisplayName(sock, senderId, profile?.name || message?.pushName || 'User');

        const lines = [
            '┃ 🏦 *WISTORIA ECONOMY*',
            '┃ ━━━━━━━━━',
            `┃ 💵 Wallet : ¥${snapshot.wallet.toLocaleString()}`,
            `┃ 🏛️ ${snapshot.activeNetwork} : ¥${snapshot.bankBalance.toLocaleString()}`,
            '┃ ━━━━━━━━━',
            `┃ 💎 Assets : ¥${snapshot.totalAssets.toLocaleString()}`,
            '┃ ━━━━━━━━━',
            `> 💠 *${snapshot.activeNetwork}*`
        ];

        await sock.sendMessage(chatId, card(lines, thumb, [], title, rankLabel), { quoted: message });
    } catch (err) {
        console.error('[balance] error:', err.message);
        await sock.sendMessage(chatId, { text: 'Failed to get balance' }, { quoted: message });
    }
}

async function dailyCommand(sock, chatId, message, senderId) {
    try {
        const result = claimDaily(senderId);
        const thumb = await getDailyThumb();

        if (result.already) {
            await sock.sendMessage(chatId, card([
                '┃ 🏦 *WISTORIA ECONOMY*',
                '┃ ━━━━━━━━━',
                '┃ Daily already claimed',
                '┃ Come back tomorrow.',
                '┃ ━━━━━━━━━'
            ], thumb, [], 'DAILY CREDITED', 'already claimed'), { quoted: message });
            return;
        }

        const streakLabel = `${result.streak} day${result.streak > 1 ? 's' : ''}`;
        const lines = [
            '╭「 💴 DAILY CREDITED 」╮',
            `┃ +¥${result.total.toLocaleString()} added to wallet`,
            '┃',
            `┃ 🔥 streak: ${streakLabel}`,
            '┃ 🏦 wistoria economy',
            '╰──────────────╯'
        ];

        await sock.sendMessage(chatId, card(lines, thumb, [], 'DAILY CREDITED', `+¥${result.total.toLocaleString()} added`), { quoted: message });
    } catch (err) {
        console.error('[daily] error:', err.message);
        await sock.sendMessage(chatId, { text: 'Failed to claim daily' }, { quoted: message });
    }
}

async function missionsCommand(sock, chatId, message, senderId) {
    try {
        const missions = getMissions(senderId);
        const thumb = await getThumb();

        const lines = [
            '┃ 🏦 *WISTORIA ECONOMY*',
            '┃ ━━━━━━━━━',
            '┃ Daily missions',
            '┃'
        ];
        for (const mission of missions) {
            const status = mission.completed ? 'done' : `${mission.progress}/${mission.goal}`;
            lines.push(`┃ ${mission.completed ? '✅' : '🔲'} ${mission.label}`);
            lines.push(`┃ reward: +${mission.reward}  progress: ${status}`);
            lines.push('┃');
        }

        await sock.sendMessage(chatId, card(lines, thumb), { quoted: message });
    } catch (err) {
        console.error('[missions] error:', err.message);
        await sock.sendMessage(chatId, { text: 'Failed to load missions' }, { quoted: message });
    }
}

module.exports = { balanceCommand, dailyCommand, missionsCommand };
