const { getBalance, addBalanceAtomic } = require('../../lib/economy');
const fs = require('fs');
const path = require('path');
const { buildStyledTextPayload } = require('./gambling-style');

const DICE = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const DEFAULT_BET = 1;
const MIN_BET = 1;
const MAX_BET = 1000000000;
const COOLDOWN_MS = 30 * 1000;
const DAILY_LIMIT = 20;
const STATE_PATH = path.join(__dirname, '../data/dice.json');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
    return 100;
}

function todayStr() {
    return new Date().toISOString().slice(0, 10);
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

function getUserState(state, jid) {
    if (!state.users) state.users = {};
    if (!state.users[jid]) {
        state.users[jid] = {
            lastRollAt: 0,
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

function face(value) {
    return DICE[Math.max(1, Math.min(6, Number(value || 1))) - 1];
}

function rollDie() {
    return Math.floor(Math.random() * 6) + 1;
}

function rollFinalDie(won) {
    return won
        ? (Math.floor(Math.random() * 3) + 4)
        : (Math.floor(Math.random() * 3) + 1);
}

function renderRolling(value, rolling) {
    const suffix = rolling ? ' rolling...' : '';
    return `🎲 𝙳𝙸𝙲𝙴\n\n╭─❖\n│ 〔 ${face(value)} 〕${suffix}\n╰────────`;
}

function buildResultText(value, bet, payout, balance) {
    if (value === 6) {
        return `${renderRolling(value, false)}\n\n╭─⌬\n│ 🎯 𝗣𝗲𝗿𝗳𝗲𝗰𝘁 𝗥𝗼𝗹𝗹\n│ 💴 𝗕𝗲𝘁   ⟶ ${bet.toLocaleString()}\n│ 💴 𝗪𝗼𝗻   ⟶ +${payout.toLocaleString()}\n│ 💳 𝗕𝗮𝗹   ⟶ ${balance.toLocaleString()}\n╰────────`;
    }

    if (value >= 4) {
        return `${renderRolling(value, false)}\n\n╭─⌬\n│ 💴 𝗕𝗲𝘁   ⟶ ${bet.toLocaleString()}\n│ 💴 𝗪𝗼𝗻   ⟶ +${payout.toLocaleString()}\n│ ✨ 𝗧𝘆𝗽𝗲  ⟶ 𝗚𝗼𝗼𝗱 𝗥𝗼𝗹𝗹\n│ 💳 𝗕𝗮𝗹   ⟶ ${balance.toLocaleString()}\n╰────────`;
    }

    return `${renderRolling(value, false)}\n\n╭─⌬\n│ 💴 𝗕𝗲𝘁   ⟶ ${bet.toLocaleString()}\n│ 📉 𝗥𝗲𝘀𝘂𝗹𝘁 ⟶ 𝗟𝗼𝘀𝘁\n│ 💳 𝗕𝗮𝗹   ⟶ ${balance.toLocaleString()}\n╰────────`;
}

async function settleBet(senderId, bet, payout) {
    const netChange = Math.max(0, Number(payout || 0)) - Math.max(0, Number(bet || 0));
    return addBalanceAtomic(senderId, netChange, { force: true, source: 'dice_settlement', category: 'gambling' });
}

async function editMessage(sock, chatId, key, text, isWin = null) {
    const payload = isWin === null
        ? { text, edit: key }
        : { ...(await buildStyledTextPayload(text, isWin)), edit: key };
    await sock.sendMessage(chatId, payload);
}

async function diceCommand(sock, chatId, message, senderId, rawText) {
    try {
        const state = loadState();
        const userState = getUserState(state, senderId);
        const now = Date.now();
        const today = todayStr();

        if (userState.dailyDate !== today) {
            userState.dailyDate = today;
            userState.dailyUsed = 0;
        }

        const cooldownRemaining = Number(userState.lastRollAt || 0) + COOLDOWN_MS - now;
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
                { text: `🎲 daily dice limit reached\n> used ${DAILY_LIMIT}/${DAILY_LIMIT} today` },
                { quoted: message }
            );
            return;
        }

        const bet = parseBet(rawText);
        if (bet === null) {
            await sock.sendMessage(chatId, { text: '❌ Please specify a bet amount.\nExample: .dice 500' }, { quoted: message });
            return;
        }

        const startingBalance = getBalance(senderId);
        if (startingBalance < bet) {
            await sock.sendMessage(
                chatId,
                { text: `You need at least ${bet.toLocaleString()} to bet.\nCurrent balance: ${startingBalance.toLocaleString()}` },
                { quoted: message }
            );
            return;
        }

        const rollA = rollDie();
        const won = Math.random() < 0.5;
        const finalRoll = rollFinalDie(won);

        const initial = await sock.sendMessage(
            chatId,
            { text: `🎲 𝙳𝙸𝙲𝙴\n\n╭─❖\n│ 〔 🎲 〕 rolling...\n╰────────` },
            { quoted: message }
        );

        userState.lastRollAt = now;
        userState.dailyUsed = Number(userState.dailyUsed || 0) + 1;
        try {
            saveState(state);
        } catch (e) {
            console.error('[dice] save state error:', e.message);
        }

        await sleep(randomDelay());
        await editMessage(sock, chatId, initial.key, renderRolling(rollA, true));

        await sleep(randomDelay());
        await editMessage(sock, chatId, initial.key, renderRolling(finalRoll, false));

        const payout = won ? bet * 2 : 0;
        await settleBet(senderId, bet, payout);

        const finalBalance = getBalance(senderId);

        await sleep(randomDelay());
        await editMessage(sock, chatId, initial.key, buildResultText(finalRoll, bet, payout, finalBalance), won);
    } catch (error) {
        console.error('[dice] error:', error?.message || error);
        await sock.sendMessage(
            chatId,
            { text: 'Dice failed. Try again in a moment.' },
            { quoted: message }
        );
    }
}





module.exports = {
  name: 'dice',
  async execute(ctx) {
    return diceCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null, ctx.rawText || null);
  }
};
