const fs = require('fs');
const path = require('path');
const { getBalance, addBalanceAtomic } = require('../../lib/economy');
const https = require('https');

const DEFAULT_BET = 1;
const MIN_BET = 1;
const MAX_BET = 1000000000;
const COOLDOWN_MS = 90 * 1000;
const DAILY_LIMIT = 5;
const STATE_PATH = path.join(__dirname, '../data/wheel.json');

const WIN_THUMB_URL = 'https://i.ibb.co/DfFjZrHn/Kaouru-Waguri.jpg';
const LOSS_THUMB_URL = 'https://i.ibb.co/G4zrX6Rg/download-6.jpg';
const PREVIEW_SOURCE_URL = 'https://segs.miku.xxx';

let winThumbCache = null;
let lossThumbCache = null;

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

async function getThumbBuffer(isWin) {
    if (isWin) {
        if (!winThumbCache) winThumbCache = await fetchBuffer(WIN_THUMB_URL).catch(() => null);
        return winThumbCache;
    }
    if (!lossThumbCache) lossThumbCache = await fetchBuffer(LOSS_THUMB_URL).catch(() => null);
    return lossThumbCache;
}

function loadState() {
    if (!fs.existsSync(STATE_PATH)) {
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        fs.writeFileSync(STATE_PATH, '{}', 'utf8');
    }

    try {
        return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch {
        return {};
    }
}

function saveState(state) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

function getUserState(state, jid) {
    if (!state.users) state.users = {};
    if (!state.users[jid]) {
        state.users[jid] = {
            lastSpinAt: 0,
            dailyDate: '',
            dailyUsed: 0
        };
    }
    return state.users[jid];
}

function formatRemaining(ms) {
    const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0 && seconds > 0) return `${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
}

function parseBet(rawText) {
    const parts = String(rawText || '').trim().split(/\s+/).slice(1);
    const amount = Number(parts[0]);
    if (!Number.isFinite(amount)) return DEFAULT_BET;
    return Math.max(MIN_BET, Math.min(MAX_BET, Math.floor(amount)));
}

function pickMultiplier() {
    return Math.random() < 0.5 ? 2 : 0;
}

function formatPrettyNumber(value) {
    return Number(value || 0).toLocaleString();
}

async function buildWheelPayload(text, isWin) {
    const thumbUrl = isWin ? WIN_THUMB_URL : LOSS_THUMB_URL;
    const jpegThumbnail = await getThumbBuffer(isWin);

    return {
        text,
        contextInfo: {
            externalAdReply: {
                title: isWin ? '🎡 WHEEL WIN' : '🎡 WHEEL LOSS',
                body: isWin ? 'nice hit' : 'tough luck',
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

function buildResultText(multiplier, winnings) {
    const isWin = multiplier > 0;
    return [
        '┃ 🎡 *ꜱᴘɪɴ ʀᴇꜱᴜʟᴛ*',
        '┃ ┉┉┉┉┉┉┉┉',
        `┃ ✧ *ᴍᴜʟᴛɪᴘʟɪᴇʀ*: x${formatPrettyNumber(multiplier)}`,
        `┃ ✧ *ᴡɪɴɴɪɴɢꜱ:* ${isWin ? '+' : ''}${formatPrettyNumber(winnings)}`,
        '┃ ┉┉┉┉┉┉┉┉',
        isWin ? '> 🎉 ɴɪᴄᴇ ʜɪᴛ!' : '> 🥀 ᴛᴏᴜɢʜ ʟᴜᴄᴋ...'
    ].join('\n');
}

async function settleBet(senderId, bet, payout) {
    const netChange = Math.max(0, Number(payout || 0)) - Math.max(0, Number(bet || 0));
    return addBalanceAtomic(senderId, netChange, { force: true, source: 'wheel_settlement', category: 'gambling' });
}

async function wheelCommand(sock, chatId, message, senderId, rawText) {
    try {
        const state = loadState();
        const userState = getUserState(state, senderId);
        const now = Date.now();
        const today = todayStr();

        if (userState.dailyDate !== today) {
            userState.dailyDate = today;
            userState.dailyUsed = 0;
        }

        const cooldownRemaining = Number(userState.lastSpinAt || 0) + COOLDOWN_MS - now;
        if (cooldownRemaining > 0) {
            await sock.sendMessage(
                chatId,
                { text: `⏳ cooldown active\n> try again in ${formatRemaining(cooldownRemaining)}` },
                { quoted: message }
            );
            return;
        }

        if (Number(userState.dailyUsed || 0) >= DAILY_LIMIT) {
            await sock.sendMessage(
                chatId,
                { text: `🎡 daily wheel limit reached\n> used ${DAILY_LIMIT}/${DAILY_LIMIT} today` },
                { quoted: message }
            );
            return;
        }

        const bet = parseBet(rawText);
        const balance = getBalance(senderId);
        if (balance < bet) {
            await sock.sendMessage(
                chatId,
                { text: `You need at least ${bet.toLocaleString()} to bet.\nCurrent balance: ${balance.toLocaleString()}` },
                { quoted: message }
            );
            return;
        }

        userState.lastSpinAt = now;
        userState.dailyUsed = Number(userState.dailyUsed || 0) + 1;
        saveState(state);

        const multiplier = pickMultiplier();
        const winnings = Math.floor(bet * multiplier);
        await settleBet(senderId, bet, winnings);

        await sock.sendMessage(
            chatId,
            await buildWheelPayload(buildResultText(multiplier, winnings), winnings > 0),
            { quoted: message }
        );
    } catch (error) {
        console.error('[wheel] error:', error?.message || error);
        await sock.sendMessage(
            chatId,
            { text: 'Wheel failed. Try again in a moment.' },
            { quoted: message }
        );
    }
}





module.exports = {
  name: 'wheel',
  async execute(ctx) {
    return wheelCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null, ctx.rawText || null);
  }
};
