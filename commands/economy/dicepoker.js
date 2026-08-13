const fs = require('fs');
const path = require('path');
const https = require('https');
const { getBalance, addBalanceAtomic } = require('../../lib/economy');

const DEFAULT_BET = 1;
const MIN_BET = 1;
const MAX_BET = 1000000000;
const COOLDOWN_MS = 50 * 1000;
const DAILY_LIMIT = 5;
const STATE_PATH = path.join(__dirname, '../data/dicepoker.json');
const PREVIEW_SOURCE_URL = 'https://segs.miku.xxx';
const WIN_THUMB_URL = 'https://i.ibb.co/xKvxYvqF/download-11.jpg';
const LOSS_THUMB_URL = 'https://i.ibb.co/v62MZjYT/Jabami-Yumeko-67.jpg';
const FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

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

async function buildDicePokerPayload(text, isWin) {
    const thumbUrl = isWin ? WIN_THUMB_URL : LOSS_THUMB_URL;
    const jpegThumbnail = await getThumbBuffer(isWin);
    return {
        text,
        contextInfo: {
            externalAdReply: {
                title: isWin ? '🎲 DICEPOKER WIN' : '🎲 DICEPOKER LOSS',
                body: isWin ? 'match found' : 'no match',
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
            lastPlayAt: 0,
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

function formatRemaining(ms) {
    const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0 && seconds > 0) return `${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
}

function parseArgs(rawText) {
    const parts = String(rawText || '').trim().split(/\s+/).slice(1);
    const target = Number(parts[0]);
    const bet = Number(parts[1]);

    return {
        target,
        bet: Number.isFinite(bet)
            ? Math.max(MIN_BET, Math.min(MAX_BET, Math.floor(bet)))
            : DEFAULT_BET
    };
}

function rollDie() {
    return Math.floor(Math.random() * 6) + 1;
}

function rollFiveDice() {
    return Array.from({ length: 5 }, () => rollDie());
}

function matchesTarget(dice, target) {
    const sums = [];
    for (let i = 0; i < dice.length; i += 1) {
        for (let j = i + 1; j < dice.length; j += 1) {
            sums.push(dice[i] + dice[j]);
        }
    }
    return sums.includes(target);
}

function generateDiceForTarget(target, matched) {
    for (let attempt = 0; attempt < 300; attempt += 1) {
        const dice = rollFiveDice();
        if (matchesTarget(dice, target) === matched) {
            return dice;
        }
    }
    return matched ? [1, 1, 6, 6, 3] : [1, 1, 1, 1, 1];
}

function buildResultText(target, dice, payout) {
    const diceFaces = dice.map((value) => FACES[value - 1]).join('  ');
    const isWin = payout > 0;

    return [
        '┃ 🎲 *SPIN RESULT*',
        '┃ ┈┈┈┈┈┈┈┈',
        `┃ ${diceFaces}`,
        '┃ ┈┈┈┈┈┈┈┈',
        `┃ *ᴛᴀʀɢᴇᴛ:* ${target}`,
        `┃ *ᴘᴀʏᴏᴜᴛ:* ${isWin ? `+$${payout.toLocaleString()}` : '$0'}`,
        '┃ ┈┈┈┈┈┈┈┈',
        isWin ? '> ✅ *ᴍᴀᴛᴄʜ ꜰᴏᴜɴᴅ!*' : '> ❌ *ɴᴏ ᴍᴀᴛᴄʜ*'
    ].join('\n');
}

async function settleBet(senderId, bet, payout) {
    const netChange = Math.max(0, Number(payout || 0)) - Math.max(0, Number(bet || 0));
    return addBalanceAtomic(senderId, netChange, { force: true, source: 'dicepoker_settlement', category: 'gambling' });
}

async function dicePokerCommand(sock, chatId, message, senderId, rawText) {
    try {
        const state = loadState();
        const userState = getUserState(state, senderId);
        const now = Date.now();

        const cooldownRemaining = Number(userState.lastPlayAt || 0) + COOLDOWN_MS - now;
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
                { text: `🎲 daily dicepoker limit reached\n> used ${DAILY_LIMIT}/${DAILY_LIMIT} today` },
                { quoted: message }
            );
            return;
        }

        const { target, bet } = parseArgs(rawText);
        if (!Number.isFinite(target) || target < 2 || target > 12) {
            await sock.sendMessage(
                chatId,
                { text: 'Usage: .dicepoker <target> <bet>\nExample: .dicepoker 8 20' },
                { quoted: message }
            );
            return;
        }

        const balance = getBalance(senderId);
        if (balance < bet) {
            await sock.sendMessage(
                chatId,
                { text: `You need at least ${bet.toLocaleString()} to bet.\nCurrent balance: ${balance.toLocaleString()}` },
                { quoted: message }
            );
            return;
        }

        userState.lastPlayAt = now;
        userState.dailyUsed = Number(userState.dailyUsed || 0) + 1;
        saveState(state);

        const matched = Math.random() < 0.5;
        const dice = generateDiceForTarget(target, matched);
        const payout = matched ? bet * 2 : 0;
        await settleBet(senderId, bet, payout);

        await sock.sendMessage(
            chatId,
            await buildDicePokerPayload(buildResultText(target, dice, payout), matched),
            { quoted: message }
        );
    } catch (error) {
        console.error('[dicepoker] error:', error?.message || error);
        await sock.sendMessage(
            chatId,
            { text: 'Dicepoker failed. Try again in a moment.' },
            { quoted: message }
        );
    }
}





module.exports = {
  name: 'dicepoker',
  async execute(ctx) {
    return dicePokerCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null, ctx.rawText || null);
  }
};
