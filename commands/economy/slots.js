const { getBalance, addBalanceAtomic } = require('../../lib/economy');
const fs = require('fs');
const path = require('path');
const { buildStyledTextPayload } = require('./gambling-style');

const SYMBOLS = ['🍒', '🍋', '🍇', '🔔', '💎', '⭐'];
const DEFAULT_BET = 1;
const MIN_BET = 1;
const MAX_BET = 1000000000;
const COOLDOWN_MS = 60 * 1000;
const DAILY_LIMIT = 10;
const STATE_PATH = path.join(__dirname, '../data/slots-only.json');

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
    return `🎰 𝗦𝗟𝗢𝗧𝗦\n\n[ ${slots.join(' | ')} ]`;
}

function buildFinalText(slots, bet, payout) {
    if (payout >= bet * 2) {
        return `${renderBoard(slots)}\n\n🎉 𝗝𝗔𝗖𝗞𝗣𝗢𝗧\n💴 𝗕𝗲𝘁: ${bet.toLocaleString()}\n💴 𝗪𝗼𝗻: +${payout.toLocaleString()}`;
    }

    if (payout > 0) {
        return `${renderBoard(slots)}\n\n✨ 𝗡𝗶𝗰𝗲 𝗵𝗶𝘁\n\n💴 𝗕𝗲𝘁: ${bet.toLocaleString()}\n💴 𝗪𝗼𝗻: +${payout.toLocaleString()}`;
    }

    return `${renderBoard(slots)}\n\n💴 𝗕𝗲𝘁: ${bet.toLocaleString()}\n💴 𝗟𝗼𝘀𝘁`;
}

async function settleBet(senderId, bet, payout) {
    const netChange = Math.max(0, Number(payout || 0)) - Math.max(0, Number(bet || 0));
    return addBalanceAtomic(senderId, netChange, { force: true, source: 'slots_settlement', category: 'gambling' });
}

function spinSlots() {
    const won = Math.random() < 0.5;

    if (won) {
        const pair = randomSymbol();
        let other = randomSymbol();
        while (other === pair) other = randomSymbol();
        const patterns = [
            [pair, pair, other],
            [pair, other, pair],
            [other, pair, pair]
        ];
        return { slots: patterns[Math.floor(Math.random() * patterns.length)], payoutMultiplier: 2, won };
    }

    let a = randomSymbol();
    let b = randomSymbol();
    let c = randomSymbol();
    while (b === a) b = randomSymbol();
    while (c === a || c === b) c = randomSymbol();
    return { slots: [a, b, c], payoutMultiplier: 0, won };
}

async function editMessage(sock, chatId, key, text, isWin = null) {
    const payload = isWin === null
        ? { text, edit: key }
        : { ...(await buildStyledTextPayload(text, isWin)), edit: key };
    await sock.sendMessage(chatId, payload);
}

async function slotsCommand(sock, chatId, message, senderId, rawText) {
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
            await sock.sendMessage(chatId, { text: `🎰 daily slots limit reached\n> used ${DAILY_LIMIT}/${DAILY_LIMIT} today` }, { quoted: message });
            return;
        }

        const bet = parseBet(rawText);
        if (bet === null) {
            await sock.sendMessage(chatId, { text: '❌ Please specify a bet amount.\nExample: .slots 500' }, { quoted: message });
            return;
        }

        const balance = getBalance(senderId);
        if (balance < bet) {
            await sock.sendMessage(chatId, { text: `You need at least ${bet.toLocaleString()} to bet.\nCurrent balance: ${balance.toLocaleString()}` }, { quoted: message });
            return;
        }

        const initial = await sock.sendMessage(chatId, { text: renderBoard(['❔', '❔', '❔']) }, { quoted: message });
        const result = spinSlots();
        const finalSlots = result.slots;

        userState.lastSpinAt = now;
        userState.dailyUsed = Number(userState.dailyUsed || 0) + 1;
        try {
            saveState(state);
        } catch (e) {
            console.error('[slots] save state error:', e.message);
        }

        await sleep(randomDelay());
        await editMessage(sock, chatId, initial.key, renderBoard([finalSlots[0], '❔', '❔']));

        await sleep(randomDelay());
        await editMessage(sock, chatId, initial.key, renderBoard([finalSlots[0], finalSlots[1], '❔']));

        const payout = Math.floor(bet * Number(result.payoutMultiplier || 0));
        const newBal = await settleBet(senderId, bet, payout);
        console.log(`[slots] settle: senderId=${senderId} bet=${bet} payout=${payout} newWallet=${newBal}`); // FIXED: slots settlement logging


        await sleep(randomDelay());
        await editMessage(sock, chatId, initial.key, buildFinalText(finalSlots, bet, payout), result.won);
    } catch (error) {
        console.error('[slots] error:', error?.message || error);
        await sock.sendMessage(chatId, { text: 'Slots failed. Try again in a moment.' }, { quoted: message });
    }
}





module.exports = {
  name: 'slots',
  async execute(ctx) {
    return slotsCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null, ctx.rawText || null);
  }
};
