const fs = require('fs');
const path = require('path');
const https = require('https');
const { getBalance, addBalanceAtomic } = require('../../lib/economy');

const STATE_PATH = path.join(process.cwd(), 'data', 'blackjack.json');
const THUMB_URL = 'https://files.catbox.moe/xc1phu.png';
const MIN_BET = 100;
const MAX_BET = 1000000000;
const GAME_TTL_MS = 10 * 60 * 1000;
const MAX_HEAT = 100;

const SUITS = ['♠️', '♥️', '♦️', '♣️'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

let thumbCache = null;

function ensureStateFile() {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(STATE_PATH)) {
        fs.writeFileSync(STATE_PATH, JSON.stringify({ games: {}, stats: {} }, null, 2), 'utf8');
    }
}

function loadState() {
    ensureStateFile();
    try {
        const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        return {
            games: parsed && typeof parsed.games === 'object' ? parsed.games : {},
            stats: parsed && typeof parsed.stats === 'object' ? parsed.stats : {}
        };
    } catch {
        return { games: {}, stats: {} };
    }
}

function saveState(state) {
    ensureStateFile();
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

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

function randomToken() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function drawCard() {
    return {
        rank: RANKS[Math.floor(Math.random() * RANKS.length)],
        suit: SUITS[Math.floor(Math.random() * SUITS.length)]
    };
}

function cardValue(rank) {
    if (rank === 'A') return 11;
    if (['K', 'Q', 'J'].includes(rank)) return 10;
    return Number(rank);
}

function handTotal(cards = []) {
    let total = 0;
    let aces = 0;
    for (const card of cards) {
        total += cardValue(card.rank);
        if (card.rank === 'A') aces += 1;
    }
    while (total > 21 && aces > 0) {
        total -= 10;
        aces -= 1;
    }
    return total;
}

function isBlackjack(cards = []) {
    return Array.isArray(cards) && cards.length === 2 && handTotal(cards) === 21;
}

function formatCard(card) {
    return `${card.rank}${card.suit}`;
}

function formatPlayerHand(cards = []) {
    if (cards.length === 2) {
        return `${formatCard(cards[0])} + ${formatCard(cards[1])}`;
    }
    return cards.map(formatCard).join(' ');
}

function formatDealerHidden(cards = []) {
    if (!cards.length) return '🂠';
    if (cards.length === 1) return `🂠 ${formatCard(cards[0])}`;
    return `🂠 ${formatCard(cards[1])}`;
}

function formatDealerOpen(cards = []) {
    return cards.map(formatCard).join(' ');
}

function formatMoney(amount) {
    return Number(amount || 0).toLocaleString();
}

function parseBet(rawText) {
    const parts = String(rawText || '').trim().split(/\s+/);
    const raw = String(parts[1] || '').trim().toLowerCase();
    if (!raw) return null;
    const multiplier = raw.endsWith('k') ? 1000 : raw.endsWith('m') ? 1000000 : 1;
    const numeric = Number(raw.replace(/[km]/g, ''));
    if (!Number.isFinite(numeric)) return null;
    return Math.max(MIN_BET, Math.min(MAX_BET, Math.floor(numeric * multiplier)));
}

function getStats(state, jid) {
    if (!state.stats[jid]) {
        state.stats[jid] = { heat: 0, winstreak: 0 };
    }
    return state.stats[jid];
}

function getGameKey(chatId, senderId) {
    return `${chatId}:${senderId}`;
}

function pruneExpiredGames(state) {
    const now = Date.now();
    for (const [key, game] of Object.entries(state.games || {})) {
        if (!game || (now - Number(game.startedAt || 0)) > GAME_TTL_MS) {
            delete state.games[key];
        }
    }
}

function buildButtons(game, balance) {
    const buttons = [
        { text: 'HIT', id: `.blackjack hit ${game.token}` },
        { text: 'STAND', id: `.blackjack stand ${game.token}` }
    ];

    if (!game.hasDoubled && game.playerCards.length === 2 && balance >= game.bet) {
        buttons.push({
            text: 'DOUBLE',
            id: `.blackjack double ${game.token}`
        });
    }

    return buttons;
}

function buildQuickReplyButtons(game, balance) {
    return buildButtons(game, balance).map((item) => ({
        name: 'quick_reply',
        params: {
            display_text: item.text,
            id: item.id
        }
    }));
}

async function sendTable(sock, chatId, message, game, balance) {
    const buttons = buildButtons(game, balance);
    const nativeFlow = buttons.map((btn) => ({
        text: btn.text,
        id: btn.id
    }));
    const bodyText = [
        `Bet : ${formatMoney(game.bet)} Coins`,
        `Dealer : ${formatDealerHidden(game.dealerCards)}`,
        `You : ${formatPlayerHand(game.playerCards)} = ${handTotal(game.playerCards)}`
    ].join('\n');

    const thumb = await getThumb();
    try {
        await sock.sendMessage(chatId, {
            text: bodyText,
            nativeFlow,
            contextInfo: {
                externalAdReply: {
                    title: 'BLACKJACK',
                    body: 'hit or stand',
                    mediaType: 1,
                    mediaUrl: '',
                    renderLargerThumbnail: false,
                    showAdAttribution: false,
                    sourceUrl: '',
                    ...(thumb ? { thumbnail: thumb } : { thumbnailUrl: THUMB_URL })
                }
            }
        }, { quoted: message });
        return;
    } catch (error) {
        console.error('[blackjack] send failed:', error?.message || error);
    }

    await sock.sendMessage(chatId, {
        text: [
            '╭━━〔 BLACKJACK 〕━━⬣',
            bodyText,
            '',
            `Reply: .bj hit | .bj stand${buttons.length > 2 ? ' | .bj double' : ''}`,
            '╰━━━━━━━━━━━━━━⬣'
        ].join('\n')
    }, { quoted: message });
}

function dealerPlay(game) {
    while (handTotal(game.dealerCards) < 17) {
        game.dealerCards.push(drawCard());
    }
}

function applyWinStats(stats) {
    stats.heat = Math.min(MAX_HEAT, Number(stats.heat || 0) + 2);
    stats.winstreak = Math.max(0, Number(stats.winstreak || 0)) + 1;
}

function applyLossStats(stats) {
    stats.heat = Math.max(0, Number(stats.heat || 0) - 1);
    stats.winstreak = 0;
}

function applyPushStats(stats) {
    stats.heat = Math.max(0, Number(stats.heat || 0));
    stats.winstreak = Math.max(0, Number(stats.winstreak || 0));
}

async function settleGame(sock, chatId, message, senderId, state, game, outcome) {
    const stats = getStats(state, senderId);
    let delta = 0;
    let titleLine = '';
    let subLine = '';

    if (outcome === 'win') {
        delta = game.bet * 2;
        applyWinStats(stats);
        titleLine = `┃ You Win +${formatMoney(game.bet * 2)}`;
        subLine = `┃ Heat : +2%`;
    } else if (outcome === 'blackjack') {
        delta = Math.floor(game.bet * 2.5);
        applyWinStats(stats);
        titleLine = `┃ Blackjack +${formatMoney(Math.floor(game.bet * 2.5))}`;
        subLine = `┃ Heat : +2%`;
    } else if (outcome === 'push') {
        delta = game.bet;
        applyPushStats(stats);
        titleLine = '┃ Push • Bet returned';
        subLine = `┃ Heat : ${stats.heat}%`;
    } else {
        delta = 0;
        applyLossStats(stats);
        titleLine = `┃ You Lose -${formatMoney(game.bet)}`;
        subLine = `┃ Heat : ${stats.heat}%`;
    }

    if (delta !== 0) {
        await addBalanceAtomic(senderId, delta, {
            force: true,
            source: 'blackjack_settlement',
            category: 'gambling',
            meta: {
                bet: game.bet,
                finalPlayer: handTotal(game.playerCards),
                finalDealer: handTotal(game.dealerCards),
                outcome
            }
        });
    }

    delete state.games[getGameKey(chatId, senderId)];
    saveState(state);

    const resultText = [
        '╭━━〔 RESULT 〕━━⬣',
        `┃ Dealer : ${formatDealerOpen(game.dealerCards)} = ${handTotal(game.dealerCards)}`,
        `┃ You : ${formatPlayerHand(game.playerCards)} = ${handTotal(game.playerCards)}`,
        titleLine,
        subLine,
        `┃ Winstreak : x${Math.max(0, Number(stats.winstreak || 0))}`,
        '╰━━━━━━━━━━━━━━⬣'
    ].join('\n');

    await sock.sendMessage(chatId, { text: resultText }, { quoted: message });
}

async function startGame(sock, chatId, message, senderId, rawText) {
    const bet = parseBet(rawText);
    if (!bet) {
        await sock.sendMessage(chatId, { text: 'Usage: .blackjack <bet>\nExample: .bj 5000' }, { quoted: message });
        return;
    }

    const balance = getBalance(senderId);
    if (balance < bet) {
        await sock.sendMessage(chatId, {
            text: `You need at least ${formatMoney(bet)} coins.\nCurrent wallet: ${formatMoney(balance)}`
        }, { quoted: message });
        return;
    }

    const state = loadState();
    pruneExpiredGames(state);
    const key = getGameKey(chatId, senderId);
    const existing = state.games[key];
    if (existing?.bet) {
        await addBalanceAtomic(senderId, existing.bet, {
            force: true,
            awardXp: false,
            source: 'blackjack_refund',
            category: 'gambling',
            meta: { reason: 'replaced_round' }
        });
    }
    delete state.games[key];

    await addBalanceAtomic(senderId, -bet, {
        force: true,
        awardXp: false,
        source: 'blackjack_reserve',
        category: 'gambling',
        meta: { bet }
    });

    const game = {
        token: randomToken(),
        bet,
        startedAt: Date.now(),
        playerCards: [drawCard(), drawCard()],
        dealerCards: [drawCard(), drawCard()],
        hasDoubled: false
    };

    state.games[key] = game;
    saveState(state);

    if (isBlackjack(game.playerCards)) {
        dealerPlay(game);
        const dealerBj = isBlackjack(game.dealerCards);
        await settleGame(sock, chatId, message, senderId, state, game, dealerBj ? 'push' : 'blackjack');
        return;
    }

    await sendTable(sock, chatId, message, game, getBalance(senderId));
}

async function handleAction(sock, chatId, message, senderId, rawText) {
    const state = loadState();
    pruneExpiredGames(state);
    const key = getGameKey(chatId, senderId);
    const game = state.games[key];
    if (!game) {
        await sock.sendMessage(chatId, { text: 'No active blackjack game.\nStart one with `.blackjack <bet>`.' }, { quoted: message });
        return;
    }

    const parts = String(rawText || '').trim().split(/\s+/);
    const action = String(parts[1] || '').toLowerCase();
    const token = String(parts[2] || '');
    if (!action) {
        await sock.sendMessage(chatId, { text: 'Use `.bj hit`, `.bj stand`, or `.bj double`.' }, { quoted: message });
        return;
    }
    if (token && token !== game.token) {
        await sock.sendMessage(chatId, { text: 'That blackjack move expired.\nStart a fresh game with `.blackjack <bet>`.' }, { quoted: message });
        return;
    }

    if ((Date.now() - Number(game.startedAt || 0)) > GAME_TTL_MS) {
        delete state.games[key];
        saveState(state);
        await addBalanceAtomic(senderId, game.bet, {
            force: true,
            awardXp: false,
            source: 'blackjack_refund',
            category: 'gambling',
            meta: { reason: 'expired_round' }
        });
        await sock.sendMessage(chatId, { text: 'That blackjack round expired.\nStart again with `.blackjack <bet>`.' }, { quoted: message });
        return;
    }

    if (action === 'hit') {
        game.playerCards.push(drawCard());
        saveState(state);

        const total = handTotal(game.playerCards);
        if (total > 21) {
            dealerPlay(game);
            await settleGame(sock, chatId, message, senderId, state, game, 'lose');
            return;
        }

        if (total === 21) {
            dealerPlay(game);
            const dealerTotal = handTotal(game.dealerCards);
            const outcome = dealerTotal > 21 || total > dealerTotal ? 'win' : dealerTotal === total ? 'push' : 'lose';
            await settleGame(sock, chatId, message, senderId, state, game, outcome);
            return;
        }

        await sendTable(sock, chatId, message, game, getBalance(senderId));
        return;
    }

    if (action === 'double') {
        const currentBalance = getBalance(senderId);
        if (game.hasDoubled || game.playerCards.length !== 2 || currentBalance < game.bet) {
            await sock.sendMessage(chatId, { text: 'Double is not available on this hand.' }, { quoted: message });
            return;
        }

        await addBalanceAtomic(senderId, -game.bet, {
            force: true,
            awardXp: false,
            source: 'blackjack_double_reserve',
            category: 'gambling',
            meta: { bet: game.bet }
        });
        game.bet *= 2;
        game.hasDoubled = true;
        game.playerCards.push(drawCard());
        saveState(state);

        const playerTotal = handTotal(game.playerCards);
        if (playerTotal > 21) {
            dealerPlay(game);
            await settleGame(sock, chatId, message, senderId, state, game, 'lose');
            return;
        }

        dealerPlay(game);
        const dealerTotal = handTotal(game.dealerCards);
        const outcome = dealerTotal > 21 || playerTotal > dealerTotal ? 'win' : dealerTotal === playerTotal ? 'push' : 'lose';
        await settleGame(sock, chatId, message, senderId, state, game, outcome);
        return;
    }

    if (action === 'stand') {
        dealerPlay(game);
        const playerTotal = handTotal(game.playerCards);
        const dealerTotal = handTotal(game.dealerCards);
        const outcome = dealerTotal > 21 || playerTotal > dealerTotal ? 'win' : dealerTotal === playerTotal ? 'push' : 'lose';
        await settleGame(sock, chatId, message, senderId, state, game, outcome);
        return;
    }

    await sock.sendMessage(chatId, { text: 'Unknown blackjack action.' }, { quoted: message });
}

async function blackjackCommand(sock, chatId, message, senderId, rawText) {
    const text = String(rawText || '').trim();
    if (/^\.(?:bj|blackjack)\s+(hit|stand|double)\b/i.test(text)) {
        return handleAction(sock, chatId, message, senderId, text);
    }
    return startGame(sock, chatId, message, senderId, text);
}

module.exports = {
    name: 'blackjack',
    alias: ['bj'],
    async execute(ctx) {
        return blackjackCommand(
            ctx.sock || null,
            ctx.chatId || null,
            ctx.message || null,
            ctx.senderId || null,
            ctx.rawText || null
        );
    }
};
