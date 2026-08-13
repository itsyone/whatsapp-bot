const fs = require('fs');
const path = require('path');
const https = require('https');
const { getBalance, addBalance } = require('../../lib/economy');

const STATE_PATH = path.join(__dirname, '..', 'data', 'bombpass.json');
const LOBBY_MS = 120 * 1000;
const MAX_PLAYERS = 5;
const MIN_BOMB_MS = 2000;
const MAX_BOMB_MS = 5000;
const ROUND_ACCEL_MS = 250;
const START_DELAY_MS = 2500;
const NEXT_ROUND_DELAY_MS = 3500;
const COOLDOWN_MS = 60 * 60 * 1000;
const COOLDOWN_BYPASS_COST = 10000;

function normalizeJid(jid) {
    if (!jid) return '';
    return String(jid).split('@')[0].split(':')[0].trim();
}
function jidMatch(a, b) {
    const na = normalizeJid(a);
    const nb = normalizeJid(b);
    return na && nb && na === nb;
}
function findInList(list, jid) {
    return list.find(p => jidMatch(p, jid)) || null;
}

const START_THUMB_URL = 'https://files.catbox.moe/fj8tgs.png';
const PASS_THUMB_URL = 'https://files.catbox.moe/c9x64g.png';
const BLAST_THUMB_URL = 'https://files.catbox.moe/t0w1k1.png';
const WIN_THUMB_URL = 'https://files.catbox.moe/qlon32.png';
const COOLDOWN_THUMB_URL = 'https://files.catbox.moe/cbgw6d.png';

const games = new Map();
const thumbCache = new Map();

function ensureState() {
    if (!fs.existsSync(STATE_PATH)) {
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        fs.writeFileSync(STATE_PATH, JSON.stringify({ cooldowns: {} }, null, 2), 'utf8');
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        if (!parsed.cooldowns || typeof parsed.cooldowns !== 'object') parsed.cooldowns = {};
        return parsed;
    } catch {
        return { cooldowns: {} };
    }
}

function saveState(state) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
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

async function getThumb(url) {
    if (!thumbCache.has(url)) {
        thumbCache.set(url, await fetchBuffer(url).catch(() => null));
    }
    return thumbCache.get(url) || null;
}

async function sendCard(sock, chatId, text, thumbUrl, mentions = [], quoted = null, title = 'BombPass', body = 'game update') {
    const thumbnail = await getThumb(thumbUrl);
    const contextInfo = thumbnail ? {
        externalAdReply: {
            title,
            body,
            thumbnail,
            mediaType: 1,
            mediaUrl: '',
            sourceUrl: '',
            showAdAttribution: false,
            renderLargerThumbnail: false
        }
    } : {
        externalAdReply: {
            title,
            body,
            thumbnailUrl: thumbUrl,
            mediaType: 1,
            mediaUrl: '',
            sourceUrl: '',
            showAdAttribution: false,
            renderLargerThumbnail: false
        }
    };

    await sock.sendMessage(chatId, { text, mentions, contextInfo }, quoted ? { quoted } : {});
}

function getMessageContextInfo(message) {
    return (
        message?.message?.extendedTextMessage?.contextInfo ||
        message?.message?.imageMessage?.contextInfo ||
        message?.message?.videoMessage?.contextInfo ||
        message?.message?.documentMessage?.contextInfo ||
        message?.message?.audioMessage?.contextInfo ||
        null
    );
}

function normalizeDigits(input = '') {
    return String(input || '').replace(/\D/g, '');
}

function getMentionedTarget(message, alive = [], rawText = '') {
    const contextInfo = getMessageContextInfo(message);
    const mentioned = Array.isArray(contextInfo?.mentionedJid) ? contextInfo.mentionedJid.filter(Boolean) : [];
    if (mentioned.length) return mentioned[0];

    const typedNumber = normalizeDigits(rawText);
    if (typedNumber) {
        const matched = alive.find((jid) => normalizeDigits(jid.split('@')[0]) === typedNumber);
        if (matched) return matched;
    }

    return '';
}

function formatAmount(amount) {
    return `¥${Math.max(0, Number(amount || 0))}`;
}

function formatRemaining(ms) {
    const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return `${totalSeconds}s`;
}

function buildLobbyText(joinCost = 0) {
    return [
        '💣 *BombPass Game Started!*',
        '',
        '> Type *.join* to enter',
        '> Max players: 5',
        ...(joinCost > 0 ? [`> Entry bet: ${formatAmount(joinCost)}`] : []),
        '> Host can type *.start* to begin early.',
        '> Starts in 2m ⏳...'
    ].join('\n');
}

function buildStartText(players, pot = 0) {
    return [
        '🔥 Game Started!',
        '',
        '👥 Players:',
        ...players.map((jid) => `@${jid.split('@')[0]}`),
        '',
        ...(pot > 0 ? [`💰 Prize Pool: ${formatAmount(pot)}`, ''] : []),
        '💣 Passing begins...'
    ].join('\n');
}

function buildHolderText(holderJid, round) {
    return [
        `💣 Round ${round}`,
        '',
        `💣 Bomb is with @${holderJid.split('@')[0]}`,
        '',
        '⚡ Type:',
        '.pass @user',
        '',
        '💣 Timer: Unknown...'
    ].join('\n');
}

function buildPassText(fromJid, toJid) {
    return `💣 @${fromJid.split('@')[0]} passed the bomb to @${toJid.split('@')[0]}!`;
}

function buildJoinText(jid, total, joinCost = 0) {
    return `👥 @${jid.split('@')[0]} joined BombPass!\n> Total: ${total}/${MAX_PLAYERS}${joinCost > 0 ? `\n> Paid: ${formatAmount(joinCost)}` : ''}`;
}


function buildInvalidPassText() {
    return [
        '❌ Invalid move!',
        '',
        '> Tag a valid player',
        '> You can’t pass to yourself'
    ].join('\n');
}

function buildBlastText(holderJid, remainingCount) {
    return [
        '💥 BOOM!',
        '',
        `@${holderJid.split('@')[0]} was holding the bomb!`,
        '',
        '❌ Eliminated',
        `👥 Players left: ${remainingCount}`,
        '',
        'Next round starting...'
    ].join('\n');
}

function buildWinnerText(winnerJid) {
    return [
        '🏆 *Winner!*',
        '',
        `@${winnerJid.split('@')[0]} is the last survivor 💣🔥`
    ].join('\n');
}

function buildCooldownText(remainingMs) {
    return [
        '⏳ BombPass cooldown active',
        '',
        `> Try again in ${formatRemaining(remainingMs)}`,
        `> Start now anyway with .bombpass ${COOLDOWN_BYPASS_COST}`
    ].join('\n');
}

function pickRandomHolder(players) {
    return players[Math.floor(Math.random() * players.length)];
}

function getExplosionDelay(round) {
    const min = Math.max(1500, MIN_BOMB_MS - ((round - 1) * ROUND_ACCEL_MS));
    const max = Math.max(min + 800, MAX_BOMB_MS - ((round - 1) * ROUND_ACCEL_MS));
    return randomInt(min, max);
}

function scheduleExplosion(sock, chatId, round) {
    const game = games.get(chatId);
    if (!game) return;

    clearTimeout(game.bombTimer);
    const delay = getExplosionDelay(round);
    game.bombTimer = setTimeout(() => {
        explodeBomb(sock, chatId).catch((error) => {
            console.error('[bombpass] explode error:', error?.message || error);
            endBombPass(chatId);
        });
    }, delay);
}

function userIsJoinCommand(message) {
    const text = message?.message?.conversation || 
                 message?.message?.extendedTextMessage?.text || 
                 message?.message?.imageMessage?.caption || 
                 message?.message?.videoMessage?.caption || 
                 '';
    const normalized = String(text || '').trim().toLowerCase();
    return normalized === '.join' || normalized === '.join bombpass' || normalized === '.join bp';
}


async function startBombPass(sock, chatId, message, senderId) {
    const state = ensureState();
    const rawText = message?.message?.conversation || message?.message?.extendedTextMessage?.text || '';
    const parts = String(rawText || '').trim().split(/\s+/);
    const requestedAmount = Math.max(0, Number(parts[1] || 0));
    const joinCost = Number.isFinite(requestedAmount) ? Math.floor(requestedAmount) : 0;

    if (!chatId.endsWith('@g.us')) {
        await sock.sendMessage(chatId, { text: 'BombPass is for groups only.' }, { quoted: message });
        return;
    }

    if (games.has(chatId)) {
        await sock.sendMessage(chatId, { text: 'A BombPass game is already running here.' }, { quoted: message });
        return;
    }

    const game = {
        chatId,
        hostId: senderId,
        lobbyOpen: true,
        started: false,
        players: new Map(),
        alive: [],
        currentHolder: '',
        round: 0,
        joinCost: Math.max(0, joinCost),
        pot: 0,
        lobbyTimer: null,
        bombTimer: null
    };

    games.set(chatId, game);

    await sendCard(
        sock,
        chatId,
        buildLobbyText(game.joinCost),
        START_THUMB_URL,
        game.alive,
        message,
        'BombPass',
        game.joinCost > 0 ? `entry bet ${formatAmount(game.joinCost)}` : 'join before it starts'
    );

    setTimeout(() => {
        if (games.has(chatId) && !games.get(chatId).started) {
            sock.sendMessage(chatId, { text: '⏳ Game starts in 60s...' }).catch(() => {});
        }
    }, 60_000);

    setTimeout(() => {
        if (games.has(chatId) && !games.get(chatId).started) {
            sock.sendMessage(chatId, { text: '⏳ Game starts in 30s...' }).catch(() => {});
        }
    }, 90_000);

    game.lobbyTimer = setTimeout(() => {
        runBombPass(sock, chatId).catch((error) => {
            console.error('[bombpass] run error:', error?.message || error);
            endBombPass(chatId);
        });
    }, LOBBY_MS);
}

async function joinBombPass(sock, chatId, message, senderId) {
    const game = games.get(chatId);
    if (!game || !game.lobbyOpen || game.started) return false;

    const input = String(message?.message?.conversation || message?.message?.extendedTextMessage?.text || '').trim().toLowerCase();

    // Host can start early with .start
    if (input === '.start') {
        if (senderId !== game.hostId) {
            await sock.sendMessage(chatId, { text: '❌ Only the game host can start the lobby!' }, { quoted: message });
            return true;
        }
        if (game.players.size < 2) {
            await sock.sendMessage(chatId, { text: '❌ Need at least 2 players to start!' }, { quoted: message });
            return true;
        }
        clearTimeout(game.lobbyTimer);
        await runBombPass(sock, chatId);
        return true;
    }

    if (game.players.size >= MAX_PLAYERS) {
        return true;
    }

    if (!game.players.has(senderId)) {
        if (game.joinCost > 0) {
            const balance = getBalance(senderId);
            if (balance < game.joinCost) {
                await sock.sendMessage(chatId, {
                    text: `❌ Need ${formatAmount(game.joinCost)} to join this BombPass.\n> Your balance: ${formatAmount(balance)}`
                }, { quoted: message });
                return true;
            }
            addBalance(senderId, -game.joinCost, { awardXp: false });
            game.pot += game.joinCost;
        }

        game.players.set(senderId, { jid: senderId });
        await sock.sendMessage(chatId, {
            text: buildJoinText(senderId, game.players.size, game.joinCost),
            mentions: [senderId]
        }, { quoted: message });
    }

    return true;
}

async function runBombPass(sock, chatId) {
    const game = games.get(chatId);
    if (!game) return;

    game.lobbyOpen = false;
    game.started = true;
    game.alive = [...game.players.keys()];

    if (game.alive.length < 2) {
        await sock.sendMessage(chatId, { text: 'BombPass cancelled. Need at least 2 players.' });
        endBombPass(chatId);
        return;
    }

    await sendCard(
        sock,
        chatId,
        buildStartText(game.alive, game.pot),
        START_THUMB_URL,
        game.alive,
        null,
        'BombPass',
        'game started'
    );

    await sleep(START_DELAY_MS);
    await beginNextRound(sock, chatId);
}

async function beginNextRound(sock, chatId) {
    const game = games.get(chatId);
    if (!game) return;

    if (game.alive.length === 1) {
        if (game.pot > 0) {
            addBalance(game.alive[0], game.pot, { awardXp: false });
        }
        await sendCard(
            sock,
            chatId,
            `${buildWinnerText(game.alive[0])}${game.pot > 0 ? `\n\n💰 Won: ${formatAmount(game.pot)}` : ''}`,
            WIN_THUMB_URL,
            [game.alive[0]],
            null,
            'BombPass',
            'winner'
        );
        endBombPass(chatId);
        return;
    }

    game.round += 1;
    game.currentHolder = pickRandomHolder(game.alive);
    console.log('[BOMBPASS] beginNextRound: round', game.round, 'holder', game.currentHolder, 'alive', game.alive);

    await sendCard(
        sock,
        chatId,
        buildHolderText(game.currentHolder, game.round),
        PASS_THUMB_URL,
        [game.currentHolder],
        null,
        'BombPass',
        'bomb holder selected'
    );

    scheduleExplosion(sock, chatId, game.round);
}

async function handleBombPassCommand(sock, chatId, message, senderId, rawText = '') {
    console.log('[BOMBPASS] .pass detected from', senderId, 'in', chatId);
    const game = games.get(chatId);
    console.log('[BOMBPASS] game exists:', !!game, 'started:', game?.started, 'currentHolder:', game?.currentHolder);
    if (!game || !game.started || !game.currentHolder) return false;

    console.log('[BOMBPASS] senderId:', senderId, 'currentHolder:', game.currentHolder, 'match:', jidMatch(senderId, game.currentHolder));
    if (!jidMatch(senderId, game.currentHolder)) {
        await sock.sendMessage(chatId, {
            text: '⛔ Only the current bomb holder can pass!'
        }, { quoted: message });
        return true;
    }

    let targetJid = getMentionedTarget(message, game.alive, rawText);
    // Normalize target to match alive list format
    if (targetJid && !game.alive.includes(targetJid)) {
        const found = findInList(game.alive, targetJid);
        if (found) targetJid = found;
    }
    console.log('[BOMBPASS] targetJid:', targetJid, 'alive:', game.alive, 'valid:', game.alive.includes(targetJid));
    const validTarget = game.alive.includes(targetJid);

    if (!targetJid || !validTarget || jidMatch(targetJid, senderId)) {
        await sendCard(
            sock,
            chatId,
            buildInvalidPassText(),
            PASS_THUMB_URL,
            [],
            message,
            'BombPass',
            'invalid move'
        );
        return true;
    }

    game.currentHolder = targetJid;

    await sendCard(
        sock,
        chatId,
        buildPassText(senderId, targetJid),
        PASS_THUMB_URL,
        [senderId, targetJid],
        message,
        'BombPass',
        'bomb passed'
    );

    scheduleExplosion(sock, chatId, game.round);
    return true;
}

async function explodeBomb(sock, chatId) {
    const game = games.get(chatId);
    if (!game || !game.currentHolder) return;
    console.log('[BOMBPASS] explodeBomb: holder', game.currentHolder, 'alive before', game.alive);

    const explodedJid = game.currentHolder;
    game.alive = game.alive.filter((jid) => jid !== explodedJid);
    game.currentHolder = '';
    clearTimeout(game.bombTimer);
    game.bombTimer = null;

    await sendCard(
        sock,
        chatId,
        buildBlastText(explodedJid, game.alive.length),
        BLAST_THUMB_URL,
        [explodedJid],
        null,
        'BombPass',
        'boom'
    );

    await sleep(NEXT_ROUND_DELAY_MS);
    await beginNextRound(sock, chatId);
}

function endBombPass(chatId) {
    const game = games.get(chatId);
    if (!game) return;
    clearTimeout(game.lobbyTimer);
    clearTimeout(game.bombTimer);
    games.delete(chatId);
}

function isBombPassParticipant(chatId, senderId) {
    const game = games.get(chatId);
    if (!game) return false;
    return game.players.has(senderId) || game.alive.includes(senderId) || !!findInList(game.alive, senderId);
}

module.exports = {
    startBombPass,
    joinBombPass,
    handleBombPassCommand,
    isBombPassParticipant
};
