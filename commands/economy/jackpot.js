const { getBalance, addBalanceAtomic } = require('../../lib/economy');
const fs = require('fs');
const path = require('path');
const { buildStyledTextPayload } = require('./gambling-style');

const SYMBOLS = ['🍒', '🍋', '🍇', '🔔', '💎', '⭐'];
const DEFAULT_BET = 1;
const MIN_BET = 1;
const MAX_BET = 1000000000;
const COOLDOWN_MS = ((1 * 60) + 45) * 60 * 1000;
const DAILY_LIMIT = 5;
const STATE_PATH = path.join(__dirname, '../data/jackpot.json');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
    return 100;
}

function randomSymbol() {
    return SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
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
    if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const remMinutes = minutes % 60;
        return `${hours}.${String(remMinutes).padStart(2, '0')}h`;
    }
    if (minutes > 0 && seconds > 0) return `${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
}

function parseBet(rawText) {
    const parts = String(rawText || '').trim().split(/\s+/).slice(1);
    const amount = Number(parts[0]);
    if (!Number.isFinite(amount)) return null;
    return Math.max(MIN_BET, Math.min(MAX_BET, Math.floor(amount)));
}

function renderBoard(slots) {
    return `🎰 𝗝𝗔𝗖𝗞𝗣𝗢𝗧\n\n[ ${slots.join(' | ')} ]`;
}

function buildFinalText(slots, bet, payout) {
    if (payout > 0) {
        return `${renderBoard(slots)}\n\n┌─⟡ ᴊᴀᴄᴋᴘᴏᴛ ⟡─┐\n 🎰 ᴡɪɴ\n 💴 +${payout.toLocaleString()}\n ✦ ʙɪɢ ʜɪᴛ\n ★★★★☆\n└────────────┘`;
    }

    return `${renderBoard(slots)}\n\n┌─⟡ ᴊᴀᴄᴋᴘᴏᴛ ⟡─┐\n 🎰 ʟᴏss\n 💴 -${bet.toLocaleString()}\n ✦ ʙᴀᴅ ʟᴜᴄᴋ\n ★☆☆☆☆\n└────────────┘`;
}

async function settleBet(senderId, bet, payout) {
    const netChange = Math.max(0, Number(payout || 0)) - Math.max(0, Number(bet || 0));
    return addBalanceAtomic(senderId, netChange, { force: true, source: 'jackpot_settlement', category: 'gambling' });
}

function spinJackpot() {
    const isWin = Math.random() < 0.5;

    if (isWin) {
        const pairSymbol = randomSymbol();
        let otherSymbol = randomSymbol();
        while (otherSymbol === pairSymbol) otherSymbol = randomSymbol();
        const patterns = [
            [pairSymbol, pairSymbol, otherSymbol],
            [pairSymbol, otherSymbol, pairSymbol],
            [otherSymbol, pairSymbol, pairSymbol]
        ];
        return {
            slots: patterns[Math.floor(Math.random() * patterns.length)],
            payoutMultiplier: 2,
            isWin
        };
    }

    let a = randomSymbol();
    let b = randomSymbol();
    let c = randomSymbol();
    while (b === a) b = randomSymbol();
    while (c === a || c === b) c = randomSymbol();
    return { slots: [a, b, c], payoutMultiplier: 0, isWin };
}

async function sendFrame(sock, chatId, message, text, isWin = null) {
    const payload = isWin === null
        ? { text }
        : await buildStyledTextPayload(text, isWin);
    await sock.sendMessage(chatId, payload, message ? { quoted: message } : {});
}

async function jackpotCommand(sock, chatId, message, senderId, rawText) {
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
            await sock.sendMessage(chatId, { text: `⏳ cooldown active\n> try again in ${formatRemaining(cooldownRemaining)}` }, { quoted: message });
            return;
        }

        if (Number(userState.dailyUsed || 0) >= DAILY_LIMIT) {
            await sock.sendMessage(chatId, { text: `🎰 daily jackpot limit reached\n> used ${DAILY_LIMIT}/${DAILY_LIMIT} today` }, { quoted: message });
            return;
        }

        const bet = parseBet(rawText);
        if (bet === null) {
            await sock.sendMessage(chatId, { text: '❌ Please specify a bet amount.\nExample: .jackpot 500' }, { quoted: message });
            return;
        }

        const balance = getBalance(senderId);
        if (balance < bet) {
            await sock.sendMessage(chatId, { text: `You need at least ${bet.toLocaleString()} to bet.\nCurrent balance: ${balance.toLocaleString()}` }, { quoted: message });
            return;
        }

        const result = spinJackpot();
        const finalSlots = result.slots;

        userState.lastSpinAt = now;
        userState.dailyUsed = Number(userState.dailyUsed || 0) + 1;
        try {
            saveState(state);
        } catch (e) {
            console.error('[jackpot] save state error:', e.message);
        }

        await sendFrame(sock, chatId, message, renderBoard(['❔', '❔', '❔']));

        await sleep(randomDelay());
        await sendFrame(sock, chatId, null, renderBoard([finalSlots[0], '❔', '❔']));

        await sleep(randomDelay());
        await sendFrame(sock, chatId, null, renderBoard([finalSlots[0], finalSlots[1], '❔']));

        const payout = Math.floor(bet * Number(result.payoutMultiplier || 0));
        await settleBet(senderId, bet, payout);


        await sleep(randomDelay());
        await sendFrame(sock, chatId, null, buildFinalText(finalSlots, bet, payout), result.isWin);
    } catch (error) {
        console.error('[jackpot] error:', error?.message || error);
        await sock.sendMessage(chatId, { text: 'Jackpot failed. Try again in a moment.' }, { quoted: message });
    }
}





module.exports = {
  name: 'jackpot',
  alias: ['jp'],
  async execute(ctx) {
    return jackpotCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null, ctx.rawText || null);
  }
};
