const https = require('https');

const LOBBY_MS = 15 * 1000;
const MAX_PLAYERS = 5;
const MIN_PLAYERS = 2;
const START_DELAY_MS = 2 * 1000;
const PLAYER_ROLL_DELAY_MS = 2200;
const ROUND_DELAY_MS = 3500;
const START_THUMB_URL = 'https://files.catbox.moe/igzk18.png';

const games = new Map();
const thumbCache = new Map();

function tag(jid) {
    return `@${String(jid || '').split('@')[0]}`;
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

async function sendThumbMessage(sock, chatId, text, mentions = [], quoted = null, thumbUrl = START_THUMB_URL) {
    const thumbnail = await getThumb(thumbUrl);
    const contextInfo = thumbnail ? {
        externalAdReply: {
            title: 'StickRoll',
            body: 'chaos gamble game',
            thumbnail,
            mediaType: 1,
            mediaUrl: '',
            sourceUrl: '',
            showAdAttribution: false,
            renderLargerThumbnail: false
        }
    } : undefined;

    await sock.sendMessage(chatId, { text, mentions, ...(contextInfo ? { contextInfo } : {}) }, quoted ? { quoted } : {});
}

function isJoinCommand(message) {
    const text = message?.message?.conversation || message?.message?.extendedTextMessage?.text || '';
    return String(text || '').trim().toLowerCase() === '.join';
}

function pickOutcome() {
    const roll = Math.random();
    if (roll < 0.34) return 'good';
    if (roll < 0.60) return 'bad';
    if (roll < 0.74) return 'jackpot';
    if (roll < 0.88) return 'chaos';
    return 'disaster';
}

function buildLobbyText() {
    return [
        '🎲 *StickRoll Started!*',
        '',
        '> Type *.join* to play',
        '> Max players: 5',
        '> Starts in 15s ⏳...'
    ].join('\n');
}

function buildStartText(players) {
    return [
        '🎲 Rolling begins!',
        '',
        '👥 Players:',
        ...players.map((jid) => tag(jid)),
        '',
        '⚡ Get ready...'
    ].join('\n');
}

function buildScoreboard(players) {
    return [
        '📊 Scores:',
        '',
        ...players.map((player) => `${tag(player.jid)} - ${player.eliminated ? 'OUT' : player.score}`)
    ].join('\n');
}

function buildFinalText(players) {
    const ranked = [...players].sort((a, b) => {
        if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
        return b.score - a.score;
    });

    const medals = ['🥇', '🥈', '🥉'];
    const lines = ['🏁 Game Over!', ''];
    ranked.slice(0, 3).forEach((player, index) => {
        lines.push(`${medals[index] || `${index + 1}.`} ${tag(player.jid)} - ${player.score} pts`);
    });
    lines.push('');
    lines.push(`👑 Winner: ${ranked[0] ? tag(ranked[0].jid) : 'nobody'}`);
    return { text: lines.join('\n'), winner: ranked[0] || null, ranked };
}

function applyChaos(players) {
    const alive = players.filter((player) => !player.eliminated);
    const scores = alive.map((player) => player.score);
    for (let i = scores.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [scores[i], scores[j]] = [scores[j], scores[i]];
    }
    alive.forEach((player, index) => {
        player.score = scores[index];
    });
}

function resolveRoll(player, players) {
    const outcome = pickOutcome();

    if (outcome === 'good') {
        player.score += 20;
        return ['✨ Lucky Roll!', '', '+20 points 🎉'].join('\n');
    }

    if (outcome === 'bad') {
        player.score -= 15;
        return ['💀 Bad Luck!', '', '-15 points'].join('\n');
    }

    if (outcome === 'jackpot') {
        player.score += 50;
        return ['👑 JACKPOT!', '', '+50 points 🔥'].join('\n');
    }

    if (outcome === 'chaos') {
        applyChaos(players);
        return ['🌀 CHAOS!', '', 'Scores shuffled randomly!'].join('\n');
    }

    player.eliminated = true;
    return ['💣 CURSED STICK!', '', '❌ Eliminated!'].join('\n');
}

async function startStickRoll(sock, chatId, message, senderId) {
    if (!chatId.endsWith('@g.us')) {
        await sock.sendMessage(chatId, { text: 'StickRoll is for groups only.' }, { quoted: message });
        return;
    }

    if (games.has(chatId)) {
        await sock.sendMessage(chatId, { text: 'A StickRoll game is already running here.' }, { quoted: message });
        return;
    }

    const game = {
        chatId,
        hostId: senderId,
        lobbyOpen: true,
        started: false,
        players: new Map(),
        rounds: randomInt(3, 5),
        lobbyTimer: null
    };

    games.set(chatId, game);

    await sendThumbMessage(sock, chatId, buildLobbyText(), [], message);

    setTimeout(() => {
        const current = games.get(chatId);
        if (current && !current.started) {
            sock.sendMessage(chatId, { text: '⏳ Game starts in 10s...' }).catch(() => {});
        }
    }, 5_000);

    setTimeout(() => {
        const current = games.get(chatId);
        if (current && !current.started) {
            sock.sendMessage(chatId, { text: '⏳ Game starts in 5s...' }).catch(() => {});
        }
    }, 10_000);

    game.lobbyTimer = setTimeout(() => {
        runStickRoll(sock, chatId).catch((error) => {
            console.error('[stickroll] run error:', error?.message || error);
            endStickRoll(chatId);
        });
    }, LOBBY_MS);
}

async function joinStickRoll(sock, chatId, message, senderId) {
    const game = games.get(chatId);
    if (!game || !game.lobbyOpen || game.started) return false;
    if (!isJoinCommand(message)) return false;

    if (game.players.size >= MAX_PLAYERS) {
        await sock.sendMessage(chatId, { text: 'StickRoll lobby is full.' }, { quoted: message });
        return true;
    }

    if (!game.players.has(senderId)) {
        game.players.set(senderId, {
            jid: senderId,
            score: 0,
            eliminated: false
        });

        await sock.sendMessage(chatId, {
            text: `👥 ${tag(senderId)} joined StickRoll!\n> Total: ${game.players.size}/${MAX_PLAYERS}`,
            mentions: [senderId]
        }, { quoted: message });
    }

    return true;
}

async function runStickRoll(sock, chatId) {
    const game = games.get(chatId);
    if (!game) return;

    game.lobbyOpen = false;
    game.started = true;

    if (game.players.size < MIN_PLAYERS) {
        await sock.sendMessage(chatId, { text: `StickRoll cancelled. Need at least ${MIN_PLAYERS} players.` });
        endStickRoll(chatId);
        return;
    }

    const players = [...game.players.values()];
    await sock.sendMessage(chatId, {
        text: buildStartText(players.map((player) => player.jid)),
        mentions: players.map((player) => player.jid)
    });

    await sleep(START_DELAY_MS);

    for (let round = 1; round <= game.rounds; round += 1) {
        const current = games.get(chatId);
        if (!current) return;

        const activePlayers = [...current.players.values()].filter((player) => !player.eliminated);
        if (activePlayers.length <= 1) break;

        await sock.sendMessage(chatId, { text: `🎲 Round ${round}` });
        await sleep(1200);

        for (const player of activePlayers) {
            const latest = games.get(chatId);
            if (!latest) return;

            const livePlayer = latest.players.get(player.jid);
            if (!livePlayer || livePlayer.eliminated) continue;

            await sock.sendMessage(chatId, {
                text: `👉 ${tag(livePlayer.jid)} is rolling...`,
                mentions: [livePlayer.jid]
            });

            await sleep(PLAYER_ROLL_DELAY_MS);

            const resultText = resolveRoll(livePlayer, [...latest.players.values()]);
            await sock.sendMessage(chatId, {
                text: resultText,
                mentions: [livePlayer.jid]
            });

            await sleep(1400);
        }

        const survivors = [...current.players.values()].filter((player) => !player.eliminated);
        await sock.sendMessage(chatId, {
            text: `📊 Score After Round\n\n${buildScoreboard([...current.players.values()])}`,
            mentions: [...current.players.values()].map((player) => player.jid)
        });

        if (survivors.length <= 1) break;
        if (round < game.rounds) await sleep(ROUND_DELAY_MS);
    }

    const result = buildFinalText([...game.players.values()]);
    await sock.sendMessage(chatId, {
        text: result.text,
        mentions: result.ranked.map((player) => player.jid)
    });

    endStickRoll(chatId);
}

function endStickRoll(chatId) {
    const game = games.get(chatId);
    if (!game) return;
    clearTimeout(game.lobbyTimer);
    games.delete(chatId);
}

function isStickRollParticipant(chatId, senderId) {
    const game = games.get(chatId);
    if (!game) return false;
    return game.players.has(senderId);
}

module.exports = {
    startStickRoll,
    joinStickRoll,
    isStickRollParticipant
};
