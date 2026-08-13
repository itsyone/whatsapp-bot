const https = require('https');
const {
    NETWORKS,
    normalizeNetwork,
    availableNetworksForCard
} = require('../../lib/bankSystem');
const {
    getEconomySnapshot,
    switchNetwork,
    depositToBank,
    withdrawFromBank
} = require('../../lib/economy');
const {
    getRegisteredProfile,
    getUnlockedNetworks,
    accessItemKeyFromNetwork,
    consumeInventoryItem,
    grantNetworkUnlock
} = require('../../lib/registrationStore');

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
const DEPOSIT_THUMB_URL = 'https://files.catbox.moe/2bcnu1.png';
const WITHDRAW_THUMB_URL = 'https://files.catbox.moe/n8bm7r.png';
const SWITCH_THUMB_URL = 'https://files.catbox.moe/ivw4cy.png';
const thumbCache = new Map();

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

async function getThumb(url) {
    if (!thumbCache.has(url)) {
        thumbCache.set(url, await fetchBuffer(url).catch(() => null));
    }
    return thumbCache.get(url) || null;
}

async function getNetworkThumb(network) {
    const key = String(network || '').trim().toLowerCase();
    return getThumb(NETWORK_THUMBS[key] || NETWORK_THUMBS.wistoria);
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
    try {
        const name = await sock.getName(jid);
        if (name) return String(name).trim();
    } catch {}
    return fallback;
}

async function getBankThumb(senderId, network) {
    const networkKey = String(network || '').trim().toLowerCase();
    if (networkKey !== 'wistoria' && networkKey !== 'eclipse') {
        return getNetworkThumb(networkKey);
    }

    const profile = getRegisteredProfile(senderId);
    const rankKey = pickRankLabel(profile?.level || 0, profile?.totalXpEarned || 0);
    return getThumb(WISTORIA_RANK_THUMBS[rankKey] || NETWORK_THUMBS.wistoria);
}

async function getWithdrawThumb() {
    return getThumb(WITHDRAW_THUMB_URL);
}

async function getDepositThumb() {
    return getThumb(DEPOSIT_THUMB_URL);
}

async function getSwitchThumb() {
    return getThumb(SWITCH_THUMB_URL);
}

function formatMoney(value) {
    return `$${Math.max(0, Math.floor(Number(value || 0))).toLocaleString()}`;
}

function formatDuration(ms) {
    const seconds = Math.max(1, Math.ceil(Number(ms || 0) / 1000));
    if (seconds >= 60) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return secs ? `${mins}m ${secs}s` : `${mins}m`;
    }
    return `${seconds}s`;
}

function parseAmount(input, wallet) {
    const raw = String(input || '').trim().toLowerCase();
    if (!raw) return 0;
    if (raw === 'all' || raw === 'max') return Math.max(0, Math.floor(wallet));

    const multiplier = raw.endsWith('k') ? 1_000 : raw.endsWith('m') ? 1_000_000 : 1;
    const numeric = Number(raw.replace(/[km]/g, ''));
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.floor(numeric * multiplier));
}

function switchResultText(result) {
    return [
        '🌐 *NETWORK SWITCHED*',
        '',
        `${result.from.toUpperCase()} → ${result.to.toUpperCase()}`,
        '',
        `Cost: -${formatMoney(result.cost)}`,
        ...(result.discountRate > 0 && result.cost < result.baseCost ? [`Card Bonus: -${Math.round(result.discountRate * 100)}%`] : []),
        ...(result.riskMode && result.riskDetail ? [`Risk: ${result.riskDetail}`] : []),
        '',
        '━━━━━━━━━━━',
        'Status: ACTIVE',
        '━━━━━━━━━━━'
    ].join('\n');
}

function switchErrorText(result, target) {
    const errors = {
        card_locked: `Your current card cannot access *${target}* yet.`,
        locked: `*${target}* is still locked.`,
        already_active: `*${target}* is already active.`,
        route_locked: `You cannot switch directly ${result.from} → ${result.to}.`,
        switch_cooldown: `Switch cooldown active. Try again in ${formatDuration(result.remainingMs)}.`,
        recent_deposit: `You deposited recently. Wait ${formatDuration(result.remainingMs)} before switching.`,
        insufficient_wallet: `You need ${formatMoney(result.cost)} in wallet to switch.`
    };
    return errors[result.reason] || 'Switch failed.';
}

async function bankCommand(sock, chatId, message, senderId) {
    try {
        const profile = getRegisteredProfile(senderId);
        const snapshot = getEconomySnapshot(senderId);
        const card = String(profile?.card || 'starter').toLowerCase();
        const available = availableNetworksForCard(card, {
            glitchUnlocked: Boolean(profile?.blackCardUnlocked),
            unlockedNetworks: getUnlockedNetworks(profile)
        });
        const thumb = await getBankThumb(senderId, snapshot.activeNetwork);
        const rankLabel = formatRankLabel(pickRankLabel(profile?.level || 0, profile?.totalXpEarned || 0));
        const title = await getDisplayName(sock, senderId, profile?.name || message?.pushName || 'User');
        const accessOrder = ['wistoria', 'neon', 'vortex', 'titan', 'glitch'];

        const lines = [
            '┌─ 🏦 BANK',
            '│',
            `│ active → *${snapshot.activeNetwork.toUpperCase()}*`,
            '│',
            '│ access:',
            ...accessOrder.map((network) => `│  ${available.includes(network) ? '✓' : '✗'} ${network}`),
            '│',
            `│ card → ${card}`,
            '└──────────'
        ];

        await sock.sendMessage(chatId, {
            text: lines.join('\n'),
            contextInfo: {
                externalAdReply: {
                    title,
                    body: rankLabel,
                    mediaType: 1,
                    mediaUrl: '',
                    renderLargerThumbnail: false,
                    showAdAttribution: false,
                    sourceUrl: '',
                    ...(thumb ? { thumbnail: thumb } : {})
                }
            }
        }, { quoted: message });
    } catch (error) {
        console.error('[bank] error:', error.message);
        await sock.sendMessage(chatId, { text: 'Failed to load bank.' }, { quoted: message });
    }
}

async function networkCommand(sock, chatId, message, senderId, rawText) {
    return switchCommand(sock, chatId, message, senderId, rawText);
}

async function switchCommand(sock, chatId, message, senderId, rawText) {
    try {
        const parts = String(rawText || '').trim().split(/\s+/);
        const target = normalizeNetwork(parts[1]);
        const risk = parts.includes('--risk');
        if (!target) {
            await sock.sendMessage(chatId, {
                text: 'Use `.switch <network>` or `.switch vortex --risk`.'
            }, { quoted: message });
            return;
        }

        let result = switchNetwork(senderId, target, { risk });
        if (!result.ok && (result.reason === 'card_locked' || result.reason === 'locked')) {
            const accessKey = accessItemKeyFromNetwork(target);
            if (accessKey) {
                const consume = consumeInventoryItem(senderId, accessKey, 1);
                if (consume?.ok) {
                    grantNetworkUnlock(senderId, target);
                    result = switchNetwork(senderId, target, { risk });
                }
            }
        }

        if (!result.ok) {
            await sock.sendMessage(chatId, { text: switchErrorText(result, target) }, { quoted: message });
            return;
        }

        const thumb = await getSwitchThumb();
        await sock.sendMessage(chatId, {
            text: switchResultText(result),
            contextInfo: {
                externalAdReply: {
                    title: 'NETWORK SWITCHED',
                    body: `${result.from} -> ${result.to}`,
                    mediaType: 1,
                    mediaUrl: '',
                    renderLargerThumbnail: false,
                    showAdAttribution: false,
                    sourceUrl: '',
                    ...(thumb ? { thumbnail: thumb } : {})
                }
            }
        }, { quoted: message });
    } catch (error) {
        console.error('[switch] error:', error.message);
        await sock.sendMessage(chatId, { text: 'Failed to switch network.' }, { quoted: message });
    }
}

async function depositCommand(sock, chatId, message, senderId, rawText) {
    try {
        const snapshot = getEconomySnapshot(senderId);
        const parts = String(rawText || '').trim().split(/\s+/);
        const amount = parseAmount(parts[1], snapshot.wallet);
        if (!amount) {
            await sock.sendMessage(chatId, {
                text: 'Use `.deposit <amount>` or `.deposit all`.'
            }, { quoted: message });
            return;
        }

        const result = depositToBank(senderId, amount, snapshot.activeNetwork);
        if (!result.ok) {
            const errors = {
                invalid_amount: 'Enter a valid deposit amount.',
                insufficient_wallet: 'You do not have enough money in wallet.',
                card_locked: `Your card cannot use *${result.network}* yet.`,
                locked: `*${result.network}* is still locked.`,
                limit_exceeded: `${result.network} limit reached. Max stored there is ${formatMoney(result.maxLimit)}.`,
                deposit_cooldown: `Deposit cooldown active. Try again in ${formatDuration(result.remainingMs)}.`
            };
            await sock.sendMessage(chatId, {
                text: errors[result.reason] || 'Deposit failed.'
            }, { quoted: message });
            return;
        }

        const thumb = await getDepositThumb();
        await sock.sendMessage(chatId, {
            text: `🏦 deposit ${formatMoney(result.deposited)}\n> bank updated 💰`,
            contextInfo: {
                externalAdReply: {
                    title: 'Deposit',
                    body: result.network,
                    mediaType: 1,
                    mediaUrl: '',
                    renderLargerThumbnail: false,
                    showAdAttribution: false,
                    sourceUrl: '',
                    ...(thumb ? { thumbnail: thumb } : {})
                }
            }
        }, { quoted: message });
    } catch (error) {
        console.error('[deposit] error:', error.message);
        await sock.sendMessage(chatId, { text: 'Deposit failed.' }, { quoted: message });
    }
}

async function withdrawCommand(sock, chatId, message, senderId, rawText) {
    try {
        const snapshot = getEconomySnapshot(senderId);
        const parts = String(rawText || '').trim().split(/\s+/);
        const amount = parseAmount(parts[1], snapshot.bankBalance);
        if (!amount) {
            await sock.sendMessage(chatId, {
                text: 'Use `.withdraw <amount>` or `.withdraw all`.'
            }, { quoted: message });
            return;
        }

        const result = withdrawFromBank(senderId, amount, snapshot.activeNetwork);
        if (!result.ok) {
            const errors = {
                invalid_amount: 'Enter a valid withdrawal amount.',
                insufficient_bank: `Not enough money stored in *${result.network}*.`,
                card_locked: `Your card cannot use *${result.network}* yet.`
            };
            await sock.sendMessage(chatId, {
                text: errors[result.reason] || 'Withdraw failed.'
            }, { quoted: message });
            return;
        }

        if (result.action === 'withdraw_pending') {
            await sock.sendMessage(chatId, {
                text: [
                    '🧊 *TITAN WITHDRAW QUEUED*',
                    '━━━━━━━━━━━',
                    `Amount : ${formatMoney(result.amount)}`,
                    `Ready  : ${formatDuration(result.readyAt - Date.now())}`,
                    `Bank   : ${formatMoney(result.bank)}`,
                    'Check `.bank` after the delay.'
                ].join('\n')
            }, { quoted: message });
            return;
        }

        const thumb = await getWithdrawThumb();
        await sock.sendMessage(chatId, {
            text: `🏦 withdraw ${formatMoney(result.amount)}\n> *wallet updated..*`,
            contextInfo: {
                externalAdReply: {
                    title: 'Withdraw',
                    body: result.network,
                    mediaType: 1,
                    mediaUrl: '',
                    renderLargerThumbnail: false,
                    showAdAttribution: false,
                    sourceUrl: '',
                    ...(thumb ? { thumbnail: thumb } : {})
                }
            }
        }, { quoted: message });
    } catch (error) {
        console.error('[withdraw] error:', error.message);
        await sock.sendMessage(chatId, { text: 'Withdraw failed.' }, { quoted: message });
    }
}

module.exports = {
    bankCommand,
    networkCommand,
    switchCommand,
    depositCommand,
    withdrawCommand
};
