const { getBalance, addBalanceAtomic } = require('../../lib/economy');
const fs = require('fs');
const https = require('https');
const path = require('path');

const DEFAULT_BET = 1;
const MIN_BET = 1;
const MAX_BET = 1000000000;
const COOLDOWN_MS = 60 * 1000;
const DAILY_LIMIT = 13;
const STATE_PATH = path.join(__dirname, '../data/coinflip.json');
const THUMB_URL = 'https://i.ibb.co/bgtdKvvk/jpeg-optimizer-Chat-GPT-Image-Mar-30-2026-01-05-11-AM-Photoroom.png';
let thumbCache = null;

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

async function getThumb() {
    if (!thumbCache) thumbCache = await fetchBuffer(THUMB_URL).catch(() => null);
    return thumbCache;
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
            lastFlipAt: 0,
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

function normalizeChoice(value) {
    const side = String(value || '').trim().toLowerCase();
    if (side === 'head' || side === 'heads') return 'heads';
    if (side === 'tail' || side === 'tails') return 'tails';
    return null;
}

function parseInput(rawText) {
    const parts = String(rawText || '').trim().split(/\s+/).slice(1);
    const choice = normalizeChoice(parts[0]);
    const amount = Number(parts[1]);

    return {
        choice,
        bet: Number.isFinite(amount) ? Math.max(MIN_BET, Math.min(MAX_BET, Math.floor(amount))) : DEFAULT_BET
    };
}

function flipCoin(choice) {
    const won = Math.random() < 0.5;
    const opposite = choice === 'heads' ? 'tails' : 'heads';
    return {
        result: won ? choice : opposite,
        won
    };
}

function buildText(choice, result, bet, won, payout) {
    if (won) {
        return `⟡ COINFLIP\n\n🎯 picked: ${choice}\n🪙 landed: ${result}\n🟢 +${payout.toLocaleString()}`;
    }

    return `⟡ COINFLIP\n\n🎯 picked: ${choice}\n🪙 landed: ${result}\n🔴 -${bet.toLocaleString()}`;
}

function buildResultMessage(text, thumb) {
    return {
        text,
        contextInfo: {
            externalAdReply: {
                title: 'COINFLIP',
                body: 'luck game',
                mediaType: 1,
                mediaUrl: '',
                renderLargerThumbnail: false,
                showAdAttribution: false,
                sourceUrl: '',
                ...(thumb ? { thumbnail: thumb } : { thumbnailUrl: THUMB_URL })
            }
        }
    };
}

async function settleBet(senderId, bet, payout) {
    const netChange = Math.max(0, Number(payout || 0)) - Math.max(0, Number(bet || 0));
    return addBalanceAtomic(senderId, netChange, { force: true, source: 'coinflip_settlement', category: 'gambling' });
}

async function coinflipCommand(sock, chatId, message, senderId, rawText) {
    try {
        const state = loadState();
        const userState = getUserState(state, senderId);
        const now = Date.now();
        const today = todayStr();

        if (userState.dailyDate !== today) {
            userState.dailyDate = today;
            userState.dailyUsed = 0;
        }

        const cooldownRemaining = Number(userState.lastFlipAt || 0) + COOLDOWN_MS - now;
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
                { text: `🪙 daily coinflip limit reached\n> used ${DAILY_LIMIT}/${DAILY_LIMIT} today` },
                { quoted: message }
            );
            return;
        }

        const { choice, bet } = parseInput(rawText);
        if (!choice) {
            await sock.sendMessage(
                chatId,
                { text: 'Use: .coinflip/.cf <heads|tails> <amount>\nExample: .coinflip tails 500' },
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

        userState.lastFlipAt = now;
        userState.dailyUsed = Number(userState.dailyUsed || 0) + 1;
        saveState(state);

        const outcome = flipCoin(choice);
        const result = outcome.result;
        const won = outcome.won;
        const payout = bet * 2;
        const thumb = await getThumb();
        await settleBet(senderId, bet, won ? payout : 0);


        await sock.sendMessage(
            chatId,
            buildResultMessage(buildText(choice, result, bet, won, payout), thumb),
            { quoted: message }
        );
    } catch (error) {
        console.error('[coinflip] error:', error?.message || error);
        await sock.sendMessage(
            chatId,
            { text: 'Coinflip failed. Try again in a moment.' },
            { quoted: message }
        );
    }
}





module.exports = {
  name: 'coinflip',
  async execute(ctx) {
    return coinflipCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null, ctx.rawText || null);
  }
};
