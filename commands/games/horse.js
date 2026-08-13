const fs = require('fs');
const path = require('path');
const { getGambleBalance, settleGamble, shouldBypassGambleLimits, getLuckFactor } = require('../../lib/gambleManager');
const https = require('https');

const DEFAULT_BET = 1;
const MIN_BET = 1;
const MAX_BET = 1000000000;
const COOLDOWN_MS = 50 * 1000;
const DAILY_LIMIT = 5;
const PENDING_TTL_MS = 2 * 60 * 1000;
const STATE_PATH = path.join(__dirname, '../data/horse.json');
const PREVIEW_SOURCE_URL = 'https://segs.miku.xxx';
const ACTIVE_THUMB_URL = 'https://i.ibb.co/gMSk9G9t/download-8.jpg';
const LOSS_THUMB_URL = 'https://i.ibb.co/DH8bMsQV/download-10.jpg';
const WIN_THUMB_URL = 'https://i.ibb.co/rGGjFy46/image.png';

const HORSES = [
    { slot: '1', icon: '🐎', place: '①', finish: '❷', oddText: '2.00x', multiplier: 2, name: 'the blaze', label: 'the blaze' },
    { slot: '2', icon: '🏇', place: '②', finish: '❶', oddText: '2.00x', multiplier: 2, name: 'storm runner', label: 'storm runner' },
    { slot: '3', icon: '🎠', place: '③', finish: '❸', oddText: '2.00x', multiplier: 2, name: 'lucky star', label: 'lucky star' }
];

let activeThumbCache = null;
let lossThumbCache = null;
let winThumbCache = null;

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

async function getThumbBuffer(kind) {
    if (kind === 'active') {
        if (!activeThumbCache) activeThumbCache = await fetchBuffer(ACTIVE_THUMB_URL).catch(() => null);
        return activeThumbCache;
    }
    if (kind === 'win') {
        if (!winThumbCache) winThumbCache = await fetchBuffer(WIN_THUMB_URL).catch(() => null);
        return winThumbCache;
    }
    if (!lossThumbCache) lossThumbCache = await fetchBuffer(LOSS_THUMB_URL).catch(() => null);
    return lossThumbCache;
}

async function buildHorsePayload(text, kind) {
    const thumbUrl = kind === 'active' ? ACTIVE_THUMB_URL : (kind === 'win' ? WIN_THUMB_URL : LOSS_THUMB_URL);
    const title = kind === 'active' ? 'HORSE BET' : (kind === 'win' ? 'HORSE WIN' : 'HORSE LOSS');
    const body = kind === 'active' ? 'race locked in' : (kind === 'win' ? 'winning ride' : 'lost the race');
    const jpegThumbnail = await getThumbBuffer(kind);

    return {
        text,
        contextInfo: {
            externalAdReply: {
                title,
                body,
                sourceUrl: PREVIEW_SOURCE_URL,
                mediaType: 1,
                renderLargerThumbnail: false,
                showAdAttribution: false,
                thumbnailUrl: thumbUrl,
                ...(jpegThumbnail && { jpegThumbnail })
            }
        }
    };
}

function loadState() {
    if (!fs.existsSync(STATE_PATH)) {
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        fs.writeFileSync(STATE_PATH, JSON.stringify({ pending: {} }, null, 2), 'utf8');
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        if (!parsed.pending) parsed.pending = {};
        return parsed;
    } catch {
        return { pending: {} };
    }
}

function saveState(state) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function parseBet(rawText) {
    const parts = String(rawText || '').trim().split(/\s+/).slice(1);
    const amount = Number(parts[0]);
    if (!Number.isFinite(amount)) return DEFAULT_BET;
    return Math.max(MIN_BET, Math.min(MAX_BET, Math.floor(amount)));
}

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

function formatRemaining(ms) {
    const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0 && seconds > 0) return `${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
}

function getUserState(state, jid) {
    if (!state.users) state.users = {};
    if (!state.users[jid]) {
        state.users[jid] = {
            lastRaceAt: 0,
            dailyDate: '',
            dailyUsed: 0
        };
    }

    const userState = state.users[jid];
    const today = todayStr();
    if (userState.dailyDate !== today) {
        userState.dailyDate = today;
        userState.dailyUsed = 0;
    }
    return userState;
}

function getPendingKey(chatId, senderId) {
    return `${chatId}::${senderId}`;
}

function cleanupPending(state) {
    const now = Date.now();
    for (const [key, value] of Object.entries(state.pending || {})) {
        if (!value || now - Number(value.createdAt || 0) > PENDING_TTL_MS) {
            delete state.pending[key];
        }
    }
}

function buildSelectionText() {
    return [
        '┃ 🏇 *SELECT YOUR HORSE*',
        '┃ ┈┈┈┈┈┈┈┈┈┈',
        '┃ ① 🐎 [ 2.00x ] - the blaze',
        '┃ ② 🏇 [ 2.00x ] - storm runner',
        '┃ ③ 🎠 [ 2.00x ] - lucky star',
        '┃ ┈┈┈┈┈┈┈┈┈┈',
        '> place your bet',
        '',
        '> reply with 1 / 2 / 3'
    ].join('\n');
}

function buildSlipText(horse, bet) {
    return [
        '┃ 🎟️ *ACTIVE BET SLIP*',
        '┃ ━━━━━━━',
        `┃ ✧ horse: [ ${horse.label} ${horse.icon} ]`,
        `┃ ✧ amount: $${bet.toLocaleString()}`,
        `┃ ✧ payout: ${horse.oddText}`,
        '┃ ━━━━━━━',
        '> waiting for race...'
    ].join('\n');
}

function chooseWinner(selectedHorse, senderId) {
    const luck = getLuckFactor(senderId);
    if (Math.random() < luck) {
        return selectedHorse;
    }

    const others = HORSES.filter((horse) => horse.slot !== selectedHorse.slot);
    return others[Math.floor(Math.random() * others.length)] || HORSES[0];
}

function buildFinishLine(order, selectedHorse, bet, payout) {
    const resultLine = payout > 0
        ? `> 🎉 *you won +$${payout.toLocaleString()}*`
        : `> 🥀 *you lost -$${bet.toLocaleString()}*`;

    return [
        '┃ 🏆 *FINISH LINE*',
        '┃ ┈┈┈┈┈┈┈┈',
        `┃ 🥇 ${order[0].place} : ${order[0].label} ${order[0].icon}`,
        `┃ 🥈 ${order[1].place} : ${order[1].label} ${order[1].icon}`,
        `┃ 🥉 ${order[2].place} : ${order[2].label} ${order[2].icon}`,
        '┃ ┈┈┈┈┈┈┈┈',
        '> the race is over',
        resultLine,
        `> your horse: ${selectedHorse.label} ${selectedHorse.icon}`
    ].join('\n');
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomRaceDelay() {
    return 3000 + Math.floor(Math.random() * 2001);
}

async function horseCommand(sock, chatId, message, senderId, rawText) {
    try {
        const state = loadState();
        cleanupPending(state);
        const userState = getUserState(state, senderId);
        const now = Date.now();

        const cooldownRemaining = Number(userState.lastRaceAt || 0) + COOLDOWN_MS - now;
        if (!shouldBypassGambleLimits(senderId) && cooldownRemaining > 0) {
            await sock.sendMessage(
                chatId,
                { text: `⏳ cooldown active\n> try again in ${formatRemaining(cooldownRemaining)}` },
                { quoted: message }
            );
            return;
        }

        if (!shouldBypassGambleLimits(senderId) && Number(userState.dailyUsed || 0) >= DAILY_LIMIT) {
            await sock.sendMessage(
                chatId,
                { text: `🏇 daily horse limit reached\n> used ${DAILY_LIMIT}/${DAILY_LIMIT} today` },
                { quoted: message }
            );
            return;
        }

        const bet = parseBet(rawText);
        const balance = getGambleBalance(senderId);
        if (balance < bet) {
            await sock.sendMessage(
                chatId,
                { text: `You need at least ${bet.toLocaleString()} to race.\nCurrent balance: ${balance.toLocaleString()}` },
                { quoted: message }
            );
            return;
        }

        const sent = await sock.sendMessage(
            chatId,
            { text: buildSelectionText() },
            { quoted: message }
        );

        userState.lastRaceAt = now;
        userState.dailyUsed = Number(userState.dailyUsed || 0) + 1;
        state.pending[getPendingKey(chatId, senderId)] = {
            bet,
            selectionMessageId: sent?.key?.id || '',
            createdAt: Date.now()
        };
        saveState(state);
    } catch (error) {
        console.error('[horse] start error:', error?.message || error);
        await sock.sendMessage(chatId, { text: 'Horse race failed. Try again in a moment.' }, { quoted: message });
    }
}

async function handleHorseReply(sock, chatId, message, senderId, rawText) {
    const pick = String(rawText || '').trim();
    if (!['1', '2', '3'].includes(pick)) return false;

    const quotedId = message.message?.extendedTextMessage?.contextInfo?.stanzaId || '';
    if (!quotedId) return false;

    const state = loadState();
    cleanupPending(state);
    const key = getPendingKey(chatId, senderId);
    const pending = state.pending[key];
    if (!pending || pending.selectionMessageId !== quotedId) {
        saveState(state);
        return false;
    }

    const selectedHorse = HORSES.find((horse) => horse.slot === pick);
    if (!selectedHorse) {
        delete state.pending[key];
        saveState(state);
        return false;
    }

    const balance = getGambleBalance(senderId);
    if (balance < pending.bet) {
        delete state.pending[key];
        saveState(state);
        await sock.sendMessage(
            chatId,
            { text: `You need at least ${pending.bet.toLocaleString()} to race.\nCurrent balance: ${balance.toLocaleString()}` },
            { quoted: message }
        );
        return true;
    }

    delete state.pending[key];
    saveState(state);

    await sock.sendMessage(
        chatId,
        await buildHorsePayload(buildSlipText(selectedHorse, pending.bet), 'active'),
        { quoted: message }
    );

    await sleep(randomRaceDelay());

    const winner = chooseWinner(selectedHorse, senderId);
    const remaining = HORSES.filter((horse) => horse.slot !== winner.slot);
    remaining.sort(() => Math.random() - 0.5);
    const order = [winner, ...remaining];

    let payout = 0;
    if (winner.slot === selectedHorse.slot) {
        payout = Math.floor(pending.bet * selectedHorse.multiplier);
    }
    await settleGamble(senderId, pending.bet, payout);

    await sock.sendMessage(
        chatId,
        await buildHorsePayload(buildFinishLine(order, selectedHorse, pending.bet, payout), payout > 0 ? 'win' : 'loss'),
        { quoted: message }
    );

    return true;
}

module.exports = {
    horseCommand,
    handleHorseReply
};

