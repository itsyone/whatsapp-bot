const fs = require('fs');
const path = require('path');
const { getBalance, applyBalanceBatchAtomic } = require('../../lib/economy');
const { getGambleBalance, shouldBypassGambleLimits } = require('../../lib/gambleManager');
const { normalizeJid } = require('../../utils/jid');

const DEFAULT_BET = 1;
const MIN_BET = 1;
const MAX_BET = 1000000000;
const COOLDOWN_MS = 60 * 1000;
const DAILY_LIMIT = 15;
const PENDING_EXPIRE_MS = 2 * 60 * 1000;
const STATE_PATH = path.join(process.cwd(), 'data', 'bet.json'); // FIXED: absolute bet state path

function loadState() {
    if (!fs.existsSync(STATE_PATH)) {
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        fs.writeFileSync(STATE_PATH, JSON.stringify({ users: {}, pending: {} }, null, 2), 'utf8');
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        if (!parsed.users) parsed.users = {};
        if (!parsed.pending) parsed.pending = {};
        return parsed;
    } catch {
        return { users: {}, pending: {} };
    }
}

function saveState(state) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

function getUserState(state, jid) {
    if (!state.users[jid]) {
        state.users[jid] = {
            lastBetAt: 0,
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

function parseAmount(raw) {
    const value = Math.floor(Number(raw || DEFAULT_BET));
    if (!Number.isFinite(value)) return DEFAULT_BET;
    return Math.max(MIN_BET, Math.min(MAX_BET, value));
}

function formatMoney(amount) {
    return Number(amount || 0).toLocaleString();
}

function formatRemaining(ms) {
    const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0 && seconds > 0) return `${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
}

function buildChallengeText(challenger, opponent, amount) {
    return [
        '⚔️ *BET DUEL* ⚔️',
        '──────────────',
        `👤 @${challenger} vs @${opponent}`,
        `💰 stake: $${formatMoney(amount)}`,
        '──────────────',
        'type *.accept* to duel'
    ].join('\n');
}

function buildRollingText(challenger, opponent, amount) {
    return [
        '⚔️ *BET DUEL* ⚔️',
        '──────────────',
        `👤 @${challenger} vs @${opponent}`,
        `💰 stake: $${formatMoney(amount)}`,
        '──────────────',
        '🎲 rolling...'
    ].join('\n');
}

function buildResultText(winnerTag, loserTag, amount, winnerIsAccepter) {
    if (winnerIsAccepter) {
        return [
            '⚔️ *BET DUEL* ⚔️',
            '──────────────',
            `👤 @${winnerTag} wins`,
            `💰 +$${formatMoney(amount)}`,
            '🔥 clean victory'
        ].join('\n');
    }

    return [
        '⚔️ *BET DUEL* ⚔️',
        '──────────────',
        `👤 @${loserTag} lost`,
        `💸 -$${formatMoney(amount)}`,
        '💀 unlucky'
    ].join('\n');
}

function extractMentionedJid(message) {
    return message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || null;
}

function getAmountFromText(rawText) {
    const parts = String(rawText || '').trim().split(/\s+/).slice(1);
    const amountToken = parts.find((part) => /^\d+$/.test(part));
    return parseAmount(amountToken);
}

function getPendingForAccepter(state, chatId, accepterId) {
    const duel = state.pending[chatId];
    if (!duel) return null;
    if (Date.now() - Number(duel.createdAt || 0) > PENDING_EXPIRE_MS) {
        delete state.pending[chatId];
        return null;
    }
    if (duel.opponentId !== normalizeJid(accepterId)) return null;
    return duel;
}

async function tryGetProfilePicture(sock, jid) {
    try {
        const url = await sock.profilePictureUrl(jid, 'image');
        if (!url) return null;
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!response.ok) return null;
        const buffer = Buffer.from(await response.arrayBuffer());
        return buffer.length ? buffer : null;
    } catch {
        return null;
    }
}

async function betCommand(sock, chatId, message, senderId, rawText) {
    try {
        const state = loadState();
        const senderState = getUserState(state, senderId);
        const opponentId = normalizeJid(extractMentionedJid(message));

        if (!opponentId) {
            await sock.sendMessage(chatId, { text: 'Usage: .bet @user <amount>' }, { quoted: message });
            return;
        }

        if (opponentId === normalizeJid(senderId)) {
            await sock.sendMessage(chatId, { text: 'You cannot duel yourself.' }, { quoted: message });
            return;
        }

        const bypassLimits = shouldBypassGambleLimits(senderId);
        const cooldownRemaining = Number(senderState.lastBetAt || 0) + COOLDOWN_MS - Date.now();
        if (!bypassLimits && cooldownRemaining > 0) {
            await sock.sendMessage(
                chatId,
                { text: `⏳ cooldown active\n> try again in ${formatRemaining(cooldownRemaining)}` },
                { quoted: message }
            );
            return;
        }

        if (!bypassLimits && Number(senderState.dailyUsed || 0) >= DAILY_LIMIT) {
            await sock.sendMessage(
                chatId,
                { text: `⚔️ daily bet limit reached\n> used ${DAILY_LIMIT}/${DAILY_LIMIT} today` },
                { quoted: message }
            );
            return;
        }

        const amount = getAmountFromText(rawText);
        const senderBalance = getGambleBalance(senderId);
        const opponentBalance = getGambleBalance(opponentId);

        if (senderBalance < amount) {
            await sock.sendMessage(
                chatId,
                { text: `You need at least $${formatMoney(amount)}.\nCurrent balance: $${formatMoney(senderBalance)}` },
                { quoted: message }
            );
            return;
        }

        if (opponentBalance < amount) {
            await sock.sendMessage(
                chatId,
                { text: `That user needs at least $${formatMoney(amount)} to duel.` },
                { quoted: message }
            );
            return;
        }

        state.pending[chatId] = {
            challengerId: senderId,
            opponentId,
            amount,
            createdAt: Date.now()
        };
        if (!bypassLimits) {
            senderState.lastBetAt = Date.now();
            senderState.dailyUsed = Number(senderState.dailyUsed || 0) + 1;
        }
        saveState(state);

        await sock.sendMessage(
            chatId,
            {
                text: buildChallengeText(senderId.split('@')[0], opponentId.split('@')[0], amount),
                mentions: [senderId, opponentId]
            },
            { quoted: message }
        );
    } catch (error) {
        console.error('[bet] challenge error:', error?.message || error);
        await sock.sendMessage(chatId, { text: 'Bet duel failed. Try again in a moment.' }, { quoted: message });
    }
}

async function acceptBetCommand(sock, chatId, message, senderId) {
    try {
        const state = loadState();
        const duel = getPendingForAccepter(state, chatId, normalizeJid(senderId));

        if (!duel) {
            saveState(state);
            await sock.sendMessage(chatId, { text: 'No pending bet duel for you right now.' }, { quoted: message });
            return;
        }

        const accepterState = getUserState(state, senderId);
        const bypassLimits = shouldBypassGambleLimits(senderId);
        const cooldownRemaining = Number(accepterState.lastBetAt || 0) + COOLDOWN_MS - Date.now();
        if (!bypassLimits && cooldownRemaining > 0) {
            await sock.sendMessage(
                chatId,
                { text: `⏳ cooldown active\n> try again in ${formatRemaining(cooldownRemaining)}` },
                { quoted: message }
            );
            return;
        }

        if (!bypassLimits && Number(accepterState.dailyUsed || 0) >= DAILY_LIMIT) {
            await sock.sendMessage(
                chatId,
                { text: `⚔️ daily bet limit reached\n> used ${DAILY_LIMIT}/${DAILY_LIMIT} today` },
                { quoted: message }
            );
            return;
        }

        const challengerBalance = getGambleBalance(duel.challengerId);
        const accepterBalance = getGambleBalance(duel.opponentId);
        if (challengerBalance < duel.amount || accepterBalance < duel.amount) {
            delete state.pending[chatId];
            saveState(state);
            await sock.sendMessage(
                chatId,
                { text: 'Bet cancelled. One of the users no longer has enough balance.' },
                { quoted: message }
            );
            return;
        }

        if (!bypassLimits) {
            accepterState.lastBetAt = Date.now();
            accepterState.dailyUsed = Number(accepterState.dailyUsed || 0) + 1;
        }
        delete state.pending[chatId];
        saveState(state);

        const lockFunds = await applyBalanceBatchAtomic([
            {
                jid: duel.challengerId,
                delta: -duel.amount,
                awardXp: false,
                actorJid: duel.challengerId,
                source: 'bet_stake_lock',
                category: 'gambling',
                meta: { opponentJid: duel.opponentId, amount: duel.amount }
            },
            {
                jid: duel.opponentId,
                delta: -duel.amount,
                awardXp: false,
                actorJid: duel.opponentId,
                source: 'bet_stake_lock',
                category: 'gambling',
                meta: { opponentJid: duel.challengerId, amount: duel.amount }
            }
        ], { force: true });
        if (!lockFunds.ok) {
            await sock.sendMessage(chatId, { text: 'Bet cancelled. Could not lock both stakes safely.' }, { quoted: message });
            return;
        }

        const challengerTag = duel.challengerId.split('@')[0];
        const accepterTag = duel.opponentId.split('@')[0];
        const rollingMessage = await sock.sendMessage(
            chatId,
            {
                text: buildRollingText(challengerTag, accepterTag, duel.amount),
                mentions: [duel.challengerId, duel.opponentId]
            },
            { quoted: message }
        );

        await new Promise((resolve) => setTimeout(resolve, 700));

        const accepterWins = Math.random() < 0.5;
        const winnerId = accepterWins ? duel.opponentId : duel.challengerId;
        const loserId = accepterWins ? duel.challengerId : duel.opponentId;
        const winnerTag = winnerId.split('@')[0];
        const loserTag = loserId.split('@')[0];

        await applyBalanceBatchAtomic([
            {
                jid: winnerId,
                delta: duel.amount * 2,
                awardXp: true,
                actorJid: winnerId,
                source: 'bet_payout',
                category: 'gambling',
                meta: { loserJid: loserId, amount: duel.amount * 2 }
            }
        ], { force: true });


        const resultText = buildResultText(winnerTag, loserTag, duel.amount, accepterWins);
        const winnerPfp = await tryGetProfilePicture(sock, winnerId);

        if (winnerPfp) {
            await sock.sendMessage(
                chatId,
                {
                    image: winnerPfp,
                    caption: resultText,
                    mentions: [winnerId, loserId]
                },
                { quoted: message }
            );
            return;
        }

        await sock.sendMessage(
            chatId,
            {
                text: resultText,
                mentions: [winnerId, loserId],
                edit: rollingMessage?.key
            },
            { quoted: message }
        );
    } catch (error) {
        console.error('[bet] accept error:', error?.message || error);
        await sock.sendMessage(chatId, { text: 'Bet duel failed. Try again in a moment.' }, { quoted: message });
    }
}

module.exports = {
    name: 'bet',
    async execute(ctx) {
        return betCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null, ctx.rawText || null);
    },
    betCommand,
    acceptBetCommand,
    getPendingForAccepter,
    loadState
};
