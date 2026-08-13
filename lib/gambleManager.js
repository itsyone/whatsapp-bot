const fs = require('fs');
const path = require('path');
const { getSession } = require('./sessionManager');
const { getBalance, addBalanceAtomic } = require('./economy');

const LUCK_STATE_PATH = path.join(__dirname, '../commands/data/luck-state.json');
const LUCK_CHANGE_MIN_MS = 2 * 60 * 60 * 1000;
const LUCK_CHANGE_MAX_MS = 8 * 60 * 60 * 1000;

const MODTEST_BALANCE = 999999999;

function isModtestEnabled(jid) {
    const data = getSession(`modtest:${jid}`);
    return Boolean(data && data.enabled);
}

function getGambleBalance(jid) {
    return isModtestEnabled(jid) ? MODTEST_BALANCE : getBalance(jid);
}

function shouldBypassGambleLimits(jid) {
    return isModtestEnabled(jid);
}

function loadLuckState() {
    try {
        if (!fs.existsSync(LUCK_STATE_PATH)) {
            fs.mkdirSync(path.dirname(LUCK_STATE_PATH), { recursive: true });
            fs.writeFileSync(LUCK_STATE_PATH, JSON.stringify({ users: {} }, null, 2), 'utf8');
            return { users: {} };
        }
        return JSON.parse(fs.readFileSync(LUCK_STATE_PATH, 'utf8'));
    } catch {
        return { users: {} };
    }
}

function saveLuckState(state) {
    try {
        fs.writeFileSync(LUCK_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
        console.error('[gambleManager] Failed to save luck state:', error);
    }
}

function getLuckFactor(jid) {
    const state = loadLuckState();
    const now = Date.now();
    const userKey = String(jid || '');

    if (!state.users[userKey]) {
        state.users[userKey] = {
            luckFactor: 0.5,
            lastChange: now,
            nextChange: now + (LUCK_CHANGE_MIN_MS + Math.random() * (LUCK_CHANGE_MAX_MS - LUCK_CHANGE_MIN_MS))
        };
        saveLuckState(state);
    }

    const userLuck = state.users[userKey];
    if (now >= userLuck.nextChange) {
        const newLuck = 0.25 + Math.random() * 0.5;
        userLuck.luckFactor = newLuck;
        userLuck.lastChange = now;
        userLuck.nextChange = now + (LUCK_CHANGE_MIN_MS + Math.random() * (LUCK_CHANGE_MAX_MS - LUCK_CHANGE_MIN_MS));
        saveLuckState(state);
        console.log(`[gambleManager] Luck factor for ${userKey.slice(0, 8)}... changed to ${newLuck.toFixed(3)}`);
    }

    return userLuck.luckFactor;
}

async function settleGamble(jid, bet, payout, opts = {}) {
    const amount = Math.max(0, Math.floor(Number(bet || 0)));
    const winAmount = Math.max(0, Math.floor(Number(payout || 0)));

    if (isModtestEnabled(jid)) {
        return {
            balance: MODTEST_BALANCE,
            net: winAmount > 0 ? winAmount : -amount,
            modtest: true,
            insufficient: false
        };
    }

    // Atomic balance guard: re-check balance at settlement time.
    // This prevents double-spend when two concurrent commands both passed
    // an earlier getBalance() check before an async yield.
    const currentBalance = getBalance(jid);
    if (currentBalance < amount) {
        return { balance: currentBalance, net: 0, modtest: false, insufficient: true };
    }

    if (winAmount > 0) {
        const netWin = winAmount - amount;
        const balance = await addBalanceAtomic(jid, netWin, {
            force: true,
            awardXp: opts.awardXp,
            source: opts.source || 'gamble_settlement',
            category: opts.category || 'gambling',
            actorJid: opts.actorJid || jid
        });
        return { balance, net: netWin, modtest: false, insufficient: false };
    }

    const balance = await addBalanceAtomic(jid, -amount, {
        force: true,
        awardXp: false,
        source: opts.source || 'gamble_settlement',
        category: opts.category || 'gambling',
        actorJid: opts.actorJid || jid
    });
    return { balance, net: -amount, modtest: false, insufficient: false };
}

module.exports = {
    MODTEST_BALANCE,
    isModtestEnabled,
    getGambleBalance,
    shouldBypassGambleLimits,
    settleGamble,
    getLuckFactor
};
