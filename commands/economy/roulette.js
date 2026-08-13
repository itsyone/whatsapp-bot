const { getBalance, addBalanceAtomic } = require('../../lib/economy');
const fs = require('fs');
const path = require('path');
const { buildStyledTextPayload } = require('./gambling-style');

const DEFAULT_BET = 1;
const MIN_BET = 1;
const MAX_BET = 1000000000;
const COOLDOWN_MS = 60 * 1000;
const DAILY_LIMIT = 12;
const STATE_PATH = path.join(process.cwd(), 'data', 'roulette.json'); // FIXED: absolute roulette state path

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

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

function parseArgs(rawText) {
    const parts = String(rawText || '').trim().split(/\s+/).slice(1);
    if (!parts.length) return { bet: null, choice: null };

    let bet = null;
    let choice = null;

    if (/^\d+$/.test(parts[0] || '')) {
        bet = Math.max(MIN_BET, Math.min(MAX_BET, Math.floor(Number(parts[0]))));
        choice = String(parts[1] || '').toLowerCase() || null;
    } else {
        choice = String(parts[0] || '').toLowerCase() || null;
        if (/^\d+$/.test(parts[1] || '')) {
            bet = Math.max(MIN_BET, Math.min(MAX_BET, Math.floor(Number(parts[1]))));
        }
    }

    return { bet, choice };
}

function spinRoulette() {
    const number = Math.floor(Math.random() * 37);
    if (number === 0) {
        return { number, color: 'green', colorIcon: '🟢', parity: 'Zero' }; // FIXED: cracked roulette emoji
    }

    const isRed = RED_NUMBERS.has(number);
    return {
        number,
        color: isRed ? 'red' : 'black',
        colorIcon: isRed ? '🔴' : '⚫', // FIXED: cracked roulette emoji
        parity: number % 2 === 0 ? 'Even' : 'Odd'
    };
}

function evaluate(choice, result, bet) {
    const normalized = String(choice || '').toLowerCase();
    if (!normalized) return { ok: false, reason: 'usage' };

    if (/^\d+$/.test(normalized)) {
        const picked = Number(normalized);
        if (picked < 0 || picked > 36) return { ok: false, reason: 'usage' };
        const won = picked === result.number;
        return {
            ok: true,
            won,
            payout: won ? bet * 36 : 0 // FIXED: real 35:1 roulette number payout
        };
    }

    const dozenMap = {
        dozen1: [1, 12],
        dozen2: [13, 24],
        dozen3: [25, 36]
    };
    if (dozenMap[normalized]) {
        const [start, end] = dozenMap[normalized];
        const won = result.number >= start && result.number <= end;
        return { ok: true, won, payout: won ? bet * 3 : 0 }; // FIXED: real 2:1 dozen payout
    }

    const columnMap = {
        column1: [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34],
        column2: [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35],
        column3: [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36]
    };
    if (columnMap[normalized]) {
        const won = columnMap[normalized].includes(result.number);
        return { ok: true, won, payout: won ? bet * 3 : 0 }; // FIXED: real 2:1 column payout
    }

    if (!['red', 'black', 'odd', 'even'].includes(normalized)) {
        return { ok: false, reason: 'usage' };
    }

    if (result.number === 0) {
        return { ok: true, won: false, payout: 0, house: true };
    }

    const won =
        (normalized === 'red' && result.color === 'red') ||
        (normalized === 'black' && result.color === 'black') ||
        (normalized === 'odd' && result.parity.toLowerCase() === 'odd') ||
        (normalized === 'even' && result.parity.toLowerCase() === 'even');

    return {
        ok: true,
        won,
        payout: won ? bet * 2 : 0 // FIXED: real 1:1 even-money payout
    };
}

function buildText(result, won, bet, payout, house) {
    const resLine = `*${result.colorIcon} ${result.number} • ${result.parity.toUpperCase()}*`; // FIXED: cracked separator

    if (house) {
        return [
            '*🎡 ROULETTE 🎡*', // FIXED: cracked title emoji
            resLine,
            `*💴 HOUSE WINS! -${bet.toLocaleString()}*` // FIXED: cracked money emoji
        ].join('\n');
    }

    if (won) {
        return [
            '*🎡 ROULETTE 🎡*', // FIXED: cracked title emoji
            resLine,
            `*💴 YOU WIN! +${payout.toLocaleString()}*` // FIXED: cracked money emoji
        ].join('\n');
    }

    return [
        '*🎡 ROULETTE 🎡*', // FIXED: cracked title emoji
        resLine,
        `*💴 YOU LOST! -${bet.toLocaleString()}*` // FIXED: cracked money emoji
    ].join('\n');
}

async function settleBet(senderId, bet, payout) {
    const netChange = Math.max(0, Number(payout || 0)) - Math.max(0, Number(bet || 0));
    return addBalanceAtomic(senderId, netChange, { force: true, source: 'roulette_settlement', category: 'gambling' });
}

async function rouletteCommand(sock, chatId, message, senderId, rawText) {
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
                { text: `⏳ cooldown active\n> try again in ${formatRemaining(cooldownRemaining)}` }, // FIXED: cracked cooldown emoji
                { quoted: message }
            );
            return;
        }

        if (Number(userState.dailyUsed || 0) >= DAILY_LIMIT) {
            await sock.sendMessage(
                chatId,
                { text: `🎡 daily roulette limit reached\n> used ${DAILY_LIMIT}/${DAILY_LIMIT} today` }, // FIXED: cracked limit emoji
                { quoted: message }
            );
            return;
        }

        const { bet, choice } = parseArgs(rawText);
        if (bet === null || !choice) {
            await sock.sendMessage(
                chatId,
                { text: '❌ Please specify a bet amount and a choice.\nExample: .roulette 100 red' }, // FIXED: cracked error emoji
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

        const result = spinRoulette(); // FIXED: real roulette spin
        const verdict = evaluate(choice, result, bet);

        if (!verdict.ok) {
            await sock.sendMessage(
                chatId,
                { text: 'Usage: .roulette <bet> <red|black|odd|even|dozen1|dozen2|dozen3|column1|column2|column3|0-36>\nExample: .roulette 100 red' },
                { quoted: message }
            );
            return;
        }

        userState.lastSpinAt = now;
        userState.dailyUsed = Number(userState.dailyUsed || 0) + 1;
        saveState(state);

        await settleBet(senderId, bet, verdict.payout);

        await sock.sendMessage(
            chatId,
            await buildStyledTextPayload(buildText(result, verdict.won, bet, verdict.payout, verdict.house), verdict.won),
            { quoted: message }
        );
    } catch (error) {
        console.error('[roulette] error:', error?.message || error);
        await sock.sendMessage(
            chatId,
            { text: 'Roulette failed. Try again in a moment.' },
            { quoted: message }
        );
    }
}

module.exports = {
  name: 'roulette',
  async execute(ctx) {
    return rouletteCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null, ctx.rawText || null);
  }
};
