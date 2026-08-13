const https = require('https');

const LOBBY_MS = 120 * 1000;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 6;
const STARTING_HP = 100;
const ROUND_DELAY_MS = 5 * 1000;

const START_IMAGE_URL = 'https://files.catbox.moe/nd8avb.jpg';
const WIN_IMAGE_URL = 'https://files.catbox.moe/o8e7p6.jpg';
const HIT_THUMB_URL = 'https://files.catbox.moe/5a1v4j.png';
const DEFENSE_THUMB_URL = 'https://files.catbox.moe/5rsj34.png';

const games = new Map();
const mediaCache = new Map();

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

async function getBuffer(url) {
    if (!mediaCache.has(url)) {
        mediaCache.set(url, await fetchBuffer(url).catch(() => null));
    }
    return mediaCache.get(url) || null;
}

async function sendThumbCard(sock, chatId, text, thumbUrl, mentions = [], quoted = null, title = 'Arena Battle', body = 'battle update') {
    const thumbnail = await getBuffer(thumbUrl);
    const contextInfo = thumbnail
        ? {
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
        }
        : {
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

async function sendImageAnnouncement(sock, chatId, imageUrl, caption, mentions = [], quoted = null) {
    await sock.sendMessage(chatId, {
        image: { url: imageUrl },
        caption,
        mentions
    }, quoted ? { quoted } : {});
}

function buildLobbyCaption() {
    return [
        '🏟️ *Arena Battle Started!*',
        '',
        '> Type *.join* to enter',
        '> Max players: 6',
        '> Host can type *.start* to begin early.',
        '> Starts in 2m ⏳...'
    ].join('\n');
}

function buildStartText(players) {
    return [
        '🔥 Arena Battle Begins!',
        '',
        '👥 Fighters:',
        ...players.map((player) => `@${player.jid.split('@')[0]}`),
        '',
        '⚔️ Let the chaos begin...'
    ].join('\n');
}

function pickTarget(alivePlayers, attackerId) {
    const targets = alivePlayers.filter((player) => player.jid !== attackerId);
    return targets[Math.floor(Math.random() * targets.length)];
}

function formatAttackLine(attacker, target, damage, dodged, critical) {
    if (dodged) {
        return `@${attacker.jid.split('@')[0]} 🛡️ @${target.jid.split('@')[0]} (dodged)`;
    }

    if (critical) {
        return `@${attacker.jid.split('@')[0]} ⚔️ @${target.jid.split('@')[0]} (-${damage}) 🔥`;
    }

    return `@${attacker.jid.split('@')[0]} ⚔️ @${target.jid.split('@')[0]} (-${damage})`;
}

function collectEliminations(players) {
    const lines = [];
    for (const player of players) {
        if (player.hp <= 0 && !player.eliminated) {
            player.eliminated = true;
            lines.push(`> 💀 @${player.jid.split('@')[0]} OUT`);
        }
    }
    return lines;
}

function getMentionList(players) {
    return players.map((player) => player.jid);
}

async function startArena(sock, chatId, message, senderId) {
    if (!chatId.endsWith('@g.us')) {
        await sock.sendMessage(chatId, { text: 'Arena Battle is for groups only.' }, { quoted: message });
        return;
    }

    if (games.has(chatId)) {
        await sock.sendMessage(chatId, { text: 'An Arena Battle is already running here.' }, { quoted: message });
        return;
    }

    const game = {
        chatId,
        hostId: senderId,
        lobbyOpen: true,
        started: false,
        round: 0,
        players: new Map(),
        lobbyTimer: null
    };

    games.set(chatId, game);

    await sendImageAnnouncement(
        sock,
        chatId,
        START_IMAGE_URL,
        buildLobbyCaption(),
        [],
        message
    );

    setTimeout(() => {
        const current = games.get(chatId);
        if (current && !current.started) {
            sock.sendMessage(chatId, { text: '⏳ Game starts in 60s...' }).catch(() => {});
        }
    }, 60_000);

    setTimeout(() => {
        const current = games.get(chatId);
        if (current && !current.started) {
            sock.sendMessage(chatId, { text: '⏳ Game starts in 30s...' }).catch(() => {});
        }
    }, 90_000);

    game.lobbyTimer = setTimeout(() => {
        runArena(sock, chatId).catch((error) => {
            console.error('[arena] run error:', error?.message || error);
            endArena(chatId);
        });
    }, LOBBY_MS);
}

async function joinArena(sock, chatId, message, senderId) {
    const game = games.get(chatId);
    if (!game || !game.lobbyOpen || game.started) return false;

    const input = String(message?.message?.conversation || message?.message?.extendedTextMessage?.text || '').trim().toLowerCase();

    // Host can start early with .start
    if (input === '.start') {
        if (senderId !== game.hostId) {
            await sock.sendMessage(chatId, { text: '❌ Only the game host can start the lobby!' }, { quoted: message });
            return true;
        }
        if (game.players.size < MIN_PLAYERS) {
            await sock.sendMessage(chatId, { text: `❌ Need at least ${MIN_PLAYERS} players to start!` }, { quoted: message });
            return true;
        }
        clearTimeout(game.lobbyTimer);
        await runArena(sock, chatId);
        return true;
    }

    if (game.players.size >= MAX_PLAYERS) {
        if (isJoinCommand(message)) {
            await sock.sendMessage(chatId, { text: 'Arena lobby is full.' }, { quoted: message });
            return true;
        }
        return false;
    }

    if (!game.players.has(senderId)) {
        game.players.set(senderId, {
            jid: senderId,
            hp: STARTING_HP,
            eliminated: false
        });

        await sock.sendMessage(chatId, {
            text: `👥 @${senderId.split('@')[0]} joined Arena Battle!\n> Total: ${game.players.size}/${MAX_PLAYERS}`,
            mentions: [senderId]
        }, { quoted: message });
    }

    return true;
}

function isJoinCommand(message) {
    const text = message?.message?.conversation || message?.message?.extendedTextMessage?.text || '';
    return String(text || '').trim().toLowerCase() === '.join';
}

async function runArena(sock, chatId) {
    const game = games.get(chatId);
    if (!game) return;

    game.lobbyOpen = false;
    game.started = true;

    if (game.players.size < MIN_PLAYERS) {
        await sock.sendMessage(chatId, {
            text: `Arena Battle cancelled. Need at least ${MIN_PLAYERS} players.`
        });
        endArena(chatId);
        return;
    }

    const fighters = [...game.players.values()];
    await sock.sendMessage(chatId, {
        text: buildStartText(fighters),
        mentions: getMentionList(fighters)
    });

    await sleep(1500);
    await runRounds(sock, chatId);
}

async function runRounds(sock, chatId) {
    while (games.has(chatId)) {
        const game = games.get(chatId);
        if (!game) return;

        const alive = [...game.players.values()].filter((player) => player.hp > 0);
        if (alive.length <= 1) {
            await announceWinner(sock, chatId, alive[0] || null);
            endArena(chatId);
            return;
        }

        game.round += 1;
        const mentions = getMentionList(alive);
        const lines = [`⚔️ Round ${game.round}`, ''];
        let usedDefenseThumb = false;

        for (const attacker of alive) {
            const currentAlive = [...game.players.values()].filter((player) => player.hp > 0);
            if (attacker.hp <= 0 || currentAlive.length <= 1) continue;

            const target = pickTarget(currentAlive, attacker.jid);
            if (!target) continue;

            const dodged = Math.random() < 0.18;
            const critical = !dodged && Math.random() < 0.14;
            const damage = dodged ? 0 : (critical ? randomInt(30, 40) : randomInt(10, 25));

            if (dodged) {
                usedDefenseThumb = true;
            } else {
                target.hp = Math.max(0, target.hp - damage);
            }

            lines.push(formatAttackLine(attacker, target, damage, dodged, critical));
        }

        const eliminations = collectEliminations([...game.players.values()]);

        if (eliminations.length) {
            lines.push('', ...eliminations);
        }

        await sendThumbCard(
            sock,
            chatId,
            lines.join('\n'),
            usedDefenseThumb ? DEFENSE_THUMB_URL : HIT_THUMB_URL,
            mentions,
            null,
            'Arena Battle',
            usedDefenseThumb ? 'dodge and defense' : 'attack phase'
        );

        const survivors = [...game.players.values()].filter((player) => player.hp > 0);
        if (survivors.length <= 1) {
            await sleep(1200);
            await announceWinner(sock, chatId, survivors[0] || null);
            endArena(chatId);
            return;
        }

        await sleep(ROUND_DELAY_MS);
    }
}

async function announceWinner(sock, chatId, winner) {
    if (!winner) {
        await sock.sendMessage(chatId, { text: 'Arena Battle ended with no winner.' });
        return;
    }

    await sendImageAnnouncement(
        sock,
        chatId,
        WIN_IMAGE_URL,
        [
            '🏆 *Arena Winner!*',
            '',
            `👑 @${winner.jid.split('@')[0]} is the last survivor 🔥`
        ].join('\n'),
        [winner.jid]
    );
}

function endArena(chatId) {
    const game = games.get(chatId);
    if (!game) return;
    clearTimeout(game.lobbyTimer);
    games.delete(chatId);
}

function isArenaParticipant(chatId, senderId) {
    const game = games.get(chatId);
    if (!game) return false;
    return game.players.has(senderId);
}

module.exports = {
    startArena,
    joinArena,
    isArenaParticipant
};
