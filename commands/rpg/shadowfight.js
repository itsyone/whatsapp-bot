const fs = require('fs');
const path = require('path');
const https = require('https');
const { getBalance, addBalance } = require('../../lib/economy');
const { resolveRegisteredJid } = require('../../lib/registrationStore');

const STATE_PATH = path.join(process.cwd(), 'data', 'shadowfight.json'); // FIXED: absolute shadowfight state path
const LOBBY_MS = 15 * 1000;
const TURN_MS = 10 * 1000;
const READY_DELAY_MS = 2 * 1000;
const RESULT_DELAY_MS = 3 * 1000;
const BETWEEN_ROUND_DELAY_MS = 4 * 1000;
const MAX_PLAYERS = 2;
const MAX_ROUNDS = 7;
const STARTING_HP = 100;
const COOLDOWN_MS = 3 * 60 * 60 * 1000;

const START_THUMB_URL = 'https://files.catbox.moe/1bd4gb.png';
const WIN_THUMB_URL = 'https://files.catbox.moe/303k2t.png';
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

function normalizeJid(jid) {
    if (!jid) return '';
    return String(jid).split('@')[0].split(':')[0].trim();
}

function jidMatch(a, b) {
    const na = normalizeJid(a);
    const nb = normalizeJid(b);
    return na && nb && na === nb;
}

function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        const https = require('https');
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

function tag(jid) {
    return `@${String(jid || '').split('@')[0]}`;
}

function findFighter(game, senderId) {
    const candidates = Array.isArray(senderId) ? senderId.filter(Boolean) : [senderId].filter(Boolean);

    for (const candidate of candidates) {
        const direct = findFighterById(game, candidate);
        if (direct) return direct;
    }

    return null;
}

function findFighterById(game, senderId) {
    const canonical = resolveRegisteredJid([senderId]);
    if (canonical && game.players.has(canonical)) return game.players.get(canonical);

    for (const [jid, fighter] of game.players.entries()) {
        if (jidMatch(jid, senderId)) return fighter;
    }

    return game.players.get(senderId) || null;
}

async function getThumb(url) {
    if (!thumbCache.has(url)) {
        thumbCache.set(url, await fetchBuffer(url).catch(() => null));
    }
    return thumbCache.get(url) || null;
}

async function sendCard(sock, chatId, text, thumbUrl, mentions = [], quoted = null, title = 'ShadowFight', body = 'game update') {
    const thumbnail = await getThumb(thumbUrl);
    const contextInfo = {
        externalAdReply: {
            title: 'Ryo',
            body: body || '',
            thumbnail: thumbnail || undefined,
            thumbnailUrl: thumbnail ? undefined : thumbUrl,
            mediaType: 1,
            mediaUrl: '',
            sourceUrl: 'google.com',
            showAdAttribution: false,
            renderLargerThumbnail: false
        }
    };

    await sock.sendMessage(chatId, { text, mentions, contextInfo }, quoted ? { quoted } : {});
}

function formatAmount(amount) {
    return `?${Math.max(0, Number(amount || 0))}`; // FIXED: cracked currency symbol
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
        '?? *ShadowFight Started!*', // FIXED: cracked intro emoji
        '',
        '> Type *.join* to enter',
        '> Max players: 2',
        ...(joinCost > 0 ? [`> Entry bet: ${formatAmount(joinCost)}`] : []),
        '> Starts in 15s ?...' // FIXED: cracked countdown emoji
    ].join('\n');
}

function buildReadyText(players, pot = 0) {
    const [a, b] = players;
    return [
        '?? Fighters Ready!', // FIXED: cracked combat emoji
        '',
        `@${a.split('@')[0]} ?? @${b.split('@')[0]}`, // FIXED: cracked versus emoji
        '',
        ...(pot > 0 ? [`?? Prize Pool: ${formatAmount(pot)}`, ''] : []), // FIXED: cracked prize emoji
        '?? Battle begins...' // FIXED: cracked battle emoji
    ].join('\n');
}

function buildStatusText(p1, p2) {
    return [
        '?? Status:', // FIXED: cracked status emoji
        '',
        `@${p1.jid.split('@')[0]} ?? ${p1.hp} HP`, // FIXED: cracked heart emoji
        `@${p2.jid.split('@')[0]} ?? ${p2.hp} HP` // FIXED: cracked heart emoji
    ].join('\n');
}

function buildWinnerText(winner, loser, pot = 0) {
    return [
        `?? @${loser.jid.split('@')[0]} has fallen!`, // FIXED: cracked defeat emoji
        '',
        `?? Winner: @${winner.jid.split('@')[0]} ????`, // FIXED: cracked winner emoji
        ...(pot > 0 ? ['', `?? Won: ${formatAmount(pot)}`] : []) // FIXED: cracked prize emoji
    ].join('\n');
}

function buildDecisionWinnerText(winner, loser, pot = 0) {
    return [
        '? Round limit reached!', // FIXED: cracked timer emoji
        '',
        `?? Final HP: @${winner.jid.split('@')[0]} ${winner.hp} vs @${loser.jid.split('@')[0]} ${loser.hp}`, // FIXED: cracked status emoji
        '',
        `?? Winner by decision: @${winner.jid.split('@')[0]} ????`, // FIXED: cracked winner emoji
        ...(pot > 0 ? ['', `?? Won: ${formatAmount(pot)}`] : []) // FIXED: cracked prize emoji
    ].join('\n');
}

function buildRoundPrompt(round, p1, p2) {
    return [
        `?? *Round ${round}*`, // FIXED: cracked round emoji
        '',
        `${p1.hp > 0 ? tag(p1.jid) : '??'} ?? ${p1.hp} HP`, // FIXED: cracked status emoji
        `${p2.hp > 0 ? tag(p2.jid) : '??'} ?? ${p2.hp} HP`, // FIXED: cracked status emoji
        '',
        '?? *Choose your move:*', // FIXED: cracked prompt emoji
        '| .attack (.a) | .defend (.d) | .special (.s)',
        '',
        '| ? 10s' // FIXED: cracked prompt emoji
    ].join('\n'); // FIXED: removed duplicate buildRoundPrompt
}

function isCritical() {
    return Math.random() < 0.16;
}

function getDamage(move, roundNumber, specialReady) {
    if (move === 'special' && specialReady) return randomInt(30, 40);
    if (move === 'attack') return randomInt(15, 25);
    return 0;
}

function normalizeMove(text = '') {
    const cmd = String(text || '').trim().toLowerCase().split(/\s+/)[0];
    if (cmd === '.attack' || cmd === '.a' || cmd === 'attack' || cmd === 'a') return 'attack';
    if (cmd === '.defend' || cmd === '.d' || cmd === 'defend' || cmd === 'd') return 'defend';
    if (cmd === '.special' || cmd === '.sepcial' || cmd === '.s' || cmd === 'special' || cmd === '.special' || cmd === 's') return 'special';
    return '';
}

function resolvePlayerAction(actor, target, move, roundNumber) {
    const usingSpecial = move === 'special' && actor.specialCooldown <= 0;
    const appliedMove = move === 'special' && !usingSpecial ? 'attack' : move;

    let damage = getDamage(appliedMove, roundNumber, usingSpecial);
    let critical = false;

    if (damage > 0 && isCritical()) {
        damage += 10;
        critical = true;
    }

    if (target.move === 'defend') {
        damage = Math.max(0, Math.floor(damage * 0.4));
    }

    if (appliedMove === 'special') {
        actor.specialCooldown = 2;
    }

    if (appliedMove === 'attack') {
        return {
            text: `?? @${actor.jid.split('@')[0]} attacks!\n\n?? -${damage} HP to @${target.jid.split('@')[0]}${critical ? '\n?? CRITICAL HIT!' : ''}`, // FIXED: cracked attack emojis
            damage,
            critical
        };
    }

    if (appliedMove === 'defend') {
        return {
            text: `??? @${actor.jid.split('@')[0]} defends!\n\nDamage reduced ??`, // FIXED: cracked defend emojis
            damage: 0,
            critical: false
        };
    }

    return {
        text: `? @${actor.jid.split('@')[0]} used SHADOW STRIKE!\n\n?? -${damage} HP to @${target.jid.split('@')[0]}${critical ? '\n?? CRITICAL HIT!' : ''}`, // FIXED: cracked special emojis
        damage,
        critical
    };
}

async function startShadowFight(sock, chatId, message, senderId) {
    if (!chatId.endsWith('@g.us')) {
        await sock.sendMessage(chatId, { text: 'ShadowFight is for groups only.' }, { quoted: message });
        return;
    }

    if (games.has(chatId)) {
        await sock.sendMessage(chatId, { text: 'A ShadowFight game is already running here.' }, { quoted: message });
        return;
    }

    const state = ensureState();
    const cooldownUntil = Number(state.cooldowns?.[senderId] || 0);
    const now = Date.now();
    if (cooldownUntil > now) {
        await sendCard(
            sock,
            chatId,
            `? Your ShadowFight cooldown is active\n\n> Try again in ${formatRemaining(cooldownUntil - now)}`,
            COOLDOWN_THUMB_URL,
            [],
            message,
            'ShadowFight',
            'cooldown active'
        );
        return;
    }

    const rawText = message?.message?.conversation || message?.message?.extendedTextMessage?.text || '';
    const parts = String(rawText || '').trim().split(/\s+/);
    const requestedAmount = Math.max(0, Number(parts[1] || 0));
    const joinCost = Number.isFinite(requestedAmount) ? Math.floor(requestedAmount) : 0;

    const game = {
        chatId,
        hostId: senderId,
        joinCost,
        pot: 0,
        lobbyOpen: true,
        started: false,
        round: 0,
        turnTimer: null,
        lobbyTimer: null,
        players: new Map(),
        turnResolve: null
    };

    games.set(chatId, game);

    await sendCard(
        sock,
        chatId,
        buildLobbyText(joinCost),
        START_THUMB_URL,
        [],
        message,
        'ShadowFight',
        joinCost > 0 ? `entry bet ${formatAmount(joinCost)}` : 'join before it starts'
    );

    setTimeout(() => {
        if (games.has(chatId) && !games.get(chatId).started) {
            sock.sendMessage(chatId, { text: '⏳ Game starts in 10s...' }).catch(() => {}); // FIXED: cracked countdown emoji
        }
    }, 5_000);

    setTimeout(() => {
        if (games.has(chatId) && !games.get(chatId).started) {
            sock.sendMessage(chatId, { text: '⏳ Game starts in 5s...' }).catch(() => {}); // FIXED: cracked countdown emoji
        }
    }, 10_000);

    game.lobbyTimer = setTimeout(() => {
        runShadowFight(sock, chatId).catch((error) => {
            console.error('[shadowfight] run error:', error?.message || error);
            endShadowFight(chatId);
        });
    }, LOBBY_MS);
}

async function joinShadowFight(sock, chatId, message, senderId) {
    const game = games.get(chatId);
    if (!game || !game.lobbyOpen || game.started) return false;

    if (game.players.size >= MAX_PLAYERS) {
        await sock.sendMessage(chatId, { text: 'ShadowFight lobby is full.' }, { quoted: message });
        return true;
    }

    if (!findFighter(game, senderId)) {
        if (game.joinCost > 0) {
            const balance = getBalance(senderId);
            if (balance < game.joinCost) {
                await sock.sendMessage(chatId, {
                    text: `❌ Need ${formatAmount(game.joinCost)} to join.\n> Your balance: ${formatAmount(balance)}` // FIXED: cracked join error emoji
                }, { quoted: message });
                return true;
            }
            addBalance(senderId, -game.joinCost, { awardXp: false });
            game.pot += game.joinCost;
        }

        const canonicalJid = resolveRegisteredJid([senderId]) || senderId;
        game.players.set(canonicalJid, {
            jid: canonicalJid,
            hp: STARTING_HP,
            move: '',
            specialCooldown: 0
        });

        await sock.sendMessage(chatId, {
            text: `👥 @${senderId.split('@')[0]} joined ShadowFight!\n> Total: ${game.players.size}/${MAX_PLAYERS}${game.joinCost > 0 ? `\n> Paid: ${formatAmount(game.joinCost)}` : ''}`, // FIXED: cracked join emoji
            mentions: [senderId]
        }, { quoted: message });
    }

    return true;
}

async function runShadowFight(sock, chatId) {
    const game = games.get(chatId);
    if (!game) return;

    game.lobbyOpen = false;
    game.started = true;

    if (game.players.size < 2) {
        if (game.joinCost > 0) {
            for (const player of game.players.values()) {
                addBalance(player.jid, game.joinCost, { awardXp: false });
            }
        }
        await sock.sendMessage(chatId, { text: 'ShadowFight cancelled. Need 2 players.' });
        endShadowFight(chatId);
        return;
    }

    const state = ensureState();
    state.cooldowns[game.hostId] = Date.now() + COOLDOWN_MS;
    saveState(state);

    const fighters = [...game.players.values()];
    await sendCard(
        sock,
        chatId,
        buildReadyText(fighters.map((player) => player.jid), game.pot),
        START_THUMB_URL,
        fighters.map((player) => player.jid),
        null,
        'ShadowFight',
        'battle started'
    );

    await sleep(READY_DELAY_MS);
    await runRounds(sock, chatId);
}

async function runRounds(sock, chatId) {
    while (games.has(chatId)) {
        const game = games.get(chatId);
        if (!game) return;

        const fighters = [...game.players.values()];
        if (fighters.length < 2) {
            endShadowFight(chatId);
            return;
        }

        const [p1, p2] = fighters;
        if (p1.hp <= 0 || p2.hp <= 0) {
            const winner = p1.hp > 0 ? p1 : p2;
            const loser = winner === p1 ? p2 : p1;
            if (game.pot > 0) {
                addBalance(winner.jid, game.pot, { awardXp: false });
            }
            await sendCard(
                sock,
                chatId,
                buildWinnerText(winner, loser, game.pot),
                WIN_THUMB_URL,
                [winner.jid, loser.jid],
                null,
                'ShadowFight',
                'winner'
            );
            endShadowFight(chatId);
            return;
        }

        if (game.round >= MAX_ROUNDS) {
            const winner = p1.hp >= p2.hp ? p1 : p2;
            const loser = winner === p1 ? p2 : p1;
            if (game.pot > 0) {
                addBalance(winner.jid, game.pot, { awardXp: false });
            }
            await sendCard(
                sock,
                chatId,
                buildDecisionWinnerText(winner, loser, game.pot),
                WIN_THUMB_URL,
                [winner.jid, loser.jid],
                null,
                'ShadowFight',
                'winner by decision'
            );
            endShadowFight(chatId);
            return;
        }

        game.round += 1;
        p1.move = '';
        p2.move = '';

        await sendCard(
            sock,
            chatId,
            buildRoundPrompt(game.round, p1, p2),
            START_THUMB_URL,
            [p1.jid, p2.jid],
            null,
            'ShadowFight',
            `round ${game.round}`
        );

        await new Promise((resolve) => {
            game.turnResolve = resolve;
            game.turnTimer = setTimeout(resolve, TURN_MS);
        });

        if (!p1.move) p1.move = 'defend';
        if (!p2.move) p2.move = 'defend';

        const first = resolvePlayerAction(p1, p2, p1.move, game.round);
        p2.hp = Math.max(0, p2.hp - first.damage);

        const second = resolvePlayerAction(p2, p1, p2.move, game.round);
        p1.hp = Math.max(0, p1.hp - second.damage);

        p1.specialCooldown = Math.max(0, p1.specialCooldown - 1);
        p2.specialCooldown = Math.max(0, p2.specialCooldown - 1);

        await sock.sendMessage(chatId, {
            text: `${first.text}\n\n${second.text}\n\n${buildStatusText(p1, p2)}`,
            mentions: [p1.jid, p2.jid]
        });

        game.turnResolve = null;
        game.turnTimer = null;
        await sleep(RESULT_DELAY_MS);

        const survivors = [p1, p2].filter((fighter) => fighter.hp > 0);
        if (survivors.length === 2 && game.round < MAX_ROUNDS) {
            await sleep(BETWEEN_ROUND_DELAY_MS);
        }
    }
}

async function handleShadowFightMove(sock, chatId, message, senderId, rawText) {
    const game = games.get(chatId);
    if (!game || !game.started) return false;

    const move = normalizeMove(rawText);
    if (!move) return false;

    const fighter = findFighter(game, [
        senderId,
        message?.key?.participant,
        message?.key?.participantAlt,
        message?.participant,
        message?.key?.remoteJid
    ]);
    if (!fighter) return false;

    if (fighter.move) {
        await sock.sendMessage(chatId, { text: 'You already picked your move this round.' }, { quoted: message });
        return true;
    }

    if (move === 'special' && fighter.specialCooldown > 0) {
        await sock.sendMessage(chatId, {
            text: `✨ Special is on cooldown.\n> Ready in ${fighter.specialCooldown} round(s)` // FIXED: cracked special emoji
        }, { quoted: message });
        return true;
    }

    fighter.move = move;

    await sock.sendMessage(chatId, {
        text: `✅ @${senderId.split('@')[0]} locked in *${move}*`, // FIXED: cracked success emoji
        mentions: [senderId]
    }, { quoted: message });

    const allChosen = [...game.players.values()].every((player) => Boolean(player.move));
    if (allChosen && typeof game.turnResolve === 'function') {
        clearTimeout(game.turnTimer);
        game.turnResolve();
    }

    return true;
}

function endShadowFight(chatId) {
    const game = games.get(chatId);
    if (!game) return;
    clearTimeout(game.lobbyTimer);
    clearTimeout(game.turnTimer);
    games.delete(chatId);
}

function isShadowFightParticipant(chatId, senderId) {
    const game = games.get(chatId);
    if (!game) return false;
    const fighter = findFighter(game, senderId);
    return !!fighter;
}

module.exports = {
    startShadowFight,
    joinShadowFight,
    handleShadowFightMove,
    isShadowFightParticipant
};
