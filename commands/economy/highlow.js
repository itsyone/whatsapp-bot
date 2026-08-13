const fs = require('fs');
const path = require('path');
const { getBalance, addBalanceAtomic } = require('../../lib/economy');
const ffmpeg = require('fluent-ffmpeg');

const DEFAULT_BET = 1;
const MIN_BET = 1;
const MAX_BET = 1000000000;
const COOLDOWN_MS = 90 * 1000;
const DAILY_LIMIT = 3;
const PAYOUT_MULTIPLIER = 2;
const STATE_PATH = path.join(process.cwd(), 'data', 'market.json'); // FIXED: absolute market state path
const WIN_MEDIA_CANDIDATES = [
    path.join(__dirname, '../lib/up.mp4'),
    path.join(__dirname, '../up.mp4'),
    path.join(__dirname, '../assets/up.mp4'),
    path.join(__dirname, '../lib/up.gif'),
    path.join(__dirname, '../up.gif'),
    path.join(__dirname, '../assets/up.gif')
];
const TEMP_DIR = path.join(process.cwd(), 'temp_market');

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

function parseArgs(rawText) {
    const parts = String(rawText || '').trim().split(/\s+/).slice(1);
    const prediction = String(parts[0] || '').toLowerCase();
    const amount = Number(parts[1]);

    return {
        prediction,
        bet: Number.isFinite(amount)
            ? Math.max(MIN_BET, Math.min(MAX_BET, Math.floor(amount)))
            : DEFAULT_BET
    };
}

function ensureTempDir() {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function getWinMediaPath() {
    return WIN_MEDIA_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || null;
}

function convertGifToMp4(inputPath) {
    return new Promise((resolve, reject) => {
        ensureTempDir();
        const outputPath = path.join(TEMP_DIR, `market-win-${Date.now()}.mp4`);

        ffmpeg(inputPath)
            .outputOptions([
                '-movflags faststart',
                '-pix_fmt yuv420p',
                '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2'
            ])
            .format('mp4')
            .save(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', reject);
    });
}

function randomVariance() {
    return (Math.random() * 0.07) - 0.035;
}

function buildCandles() {
    const points = [100 + Math.random() * 25];
    for (let index = 1; index < 5; index += 1) {
        const previous = points[index - 1];
        const next = Math.max(1, previous * (1 + randomVariance()));
        points.push(Number(next.toFixed(2)));
    }
    return points;
}

function describeTrend(points) {
    const start = points[0];
    const end = points[points.length - 1];
    return end >= start ? 'up' : 'down';
}

function buildResultText(prediction, won, bet, points) {
    const trend = describeTrend(points);
    const candle = trend === 'up' ? '📈' : '📉'; // FIXED: cracked chart emoji
    const amount = won ? Math.floor(bet * PAYOUT_MULTIPLIER) : bet;
    const resultLine = won
        ? `+${amount.toLocaleString()} • 🎉 perfect read`
        : `-${amount.toLocaleString()} • 💀 market said no`; // FIXED: cracked result emojis

    return [
        '📊 BTC/USDT', // FIXED: cracked title emoji
        '',
        `prediction: *${prediction}*`,
        `move: ${candle} *${trend}*`,
        `path: ${points.map((point) => point.toFixed(2)).join(' -> ')}`, // FIXED: real candle sequence
        '',
        resultLine
    ].join('\n');
}

async function settleBet(senderId, bet, payout) {
    const netChange = Math.max(0, Number(payout || 0)) - Math.max(0, Number(bet || 0));
    return addBalanceAtomic(senderId, netChange, { force: true, source: 'highlow_settlement', category: 'gambling' });
}

async function marketCommand(sock, chatId, message, senderId, rawText) {
    try {
        const state = loadState();
        const userState = getUserState(state, senderId);
        const now = Date.now();
        const today = todayStr();

        if (userState.dailyDate !== today) {
            userState.dailyDate = today;
            userState.dailyUsed = 0;
        }

        const cooldownRemaining = Number(userState.lastPlayAt || 0) + COOLDOWN_MS - now;
        if (cooldownRemaining > 0) {
            await sock.sendMessage(
                chatId,
                { text: `⏳ cooldown active\n> try again in ${formatRemaining(cooldownRemaining)}` }, // FIXED: cracked cooldown emoji
                { quoted: message }
            );
            return;
        }

        if (Number(userState.dailyUsed || 0) >= DAILY_LIMIT) {
            await sock.sendMessage(
                chatId,
                { text: `📊 daily market limit reached\n> used ${DAILY_LIMIT}/${DAILY_LIMIT} today` }, // FIXED: cracked limit emoji
                { quoted: message }
            );
            return;
        }

        const { prediction, bet } = parseArgs(rawText);
        if (!['up', 'down'].includes(prediction)) {
            await sock.sendMessage(
                chatId,
                { text: 'Usage: .market <up/down> <bet>\nExample: .market up 20' },
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

        const points = buildCandles();
        const actualTrend = describeTrend(points);
        const won = actualTrend === prediction;
        const payout = won ? Math.floor(bet * PAYOUT_MULTIPLIER) : 0;
        await settleBet(senderId, bet, payout);

        if (won) {
            const winMediaPath = getWinMediaPath();
            if (prediction === 'up' && winMediaPath) {
                let playablePath = winMediaPath;
                if (path.extname(winMediaPath).toLowerCase() === '.gif') {
                    try {
                        playablePath = await convertGifToMp4(winMediaPath);
                    } catch (convertError) {
                        console.error('[market] gif convert error:', convertError?.message || convertError);
                        playablePath = null;
                    }
                }

                if (playablePath) {
                    await sock.sendMessage(
                        chatId,
                        {
                            video: { url: playablePath },
                            mimetype: 'video/mp4',
                            gifPlayback: true,
                            caption: buildResultText(prediction, true, bet, points)
                        },
                        { quoted: message }
                    );
                    return;
                }
            }
        }

        await sock.sendMessage(
            chatId,
            { text: buildResultText(prediction, won, bet, points) },
            { quoted: message }
        );
    } catch (error) {
        console.error('[market] error:', error?.message || error);
        await sock.sendMessage(
            chatId,
            { text: 'Market failed. Try again in a moment.' },
            { quoted: message }
        );
    }
}

module.exports = {
  name: 'highlow',
  async execute(ctx) {
    return marketCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null, ctx.rawText || null);
  }
};
