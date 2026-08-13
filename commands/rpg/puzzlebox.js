const fs = require('fs');
const path = require('path');
const https = require('https');
const Groq = require('groq-sdk');
const { addBalance, progressMission } = require('../../lib/economy');

const STATE_PATH = path.join(__dirname, '..', 'data', 'puzzlebox.json');
const LOBBY_MS = 120 * 1000;
const ROUND_MS = 18 * 1000;
const TOTAL_ROUNDS = 5;
const COOLDOWN_MS = 0;
const WIN_REWARD = 20;

const ROUND_THUMB_URL = 'https://files.catbox.moe/g9vyzn.png';
const CORRECT_THUMB_URL = 'https://files.catbox.moe/dir2ud.png';
const COOLDOWN_THUMB_URL = 'https://files.catbox.moe/cbgw6d.png';

const PUZZLES = [
    { type: 'unscramble', prompt: 'Unscramble: LPAEPA', answer: 'apple' },
    { type: 'unscramble', prompt: 'Unscramble: TOBTR', answer: 'robot' },
    { type: 'unscramble', prompt: 'Unscramble: BKAER', answer: 'baker' },
    { type: 'unscramble', prompt: 'Unscramble: RUTTLE', answer: 'turtle' },
    { type: 'unscramble', prompt: 'Unscramble: OOKB', answer: 'book' },
    { type: 'riddle', prompt: "What has keys but can't open locks?", answer: 'piano' },
    { type: 'riddle', prompt: 'What has hands but cannot clap?', answer: 'clock' },
    { type: 'riddle', prompt: 'What gets wetter the more it dries?', answer: 'towel' },
    { type: 'riddle', prompt: 'What has one eye but cannot see?', answer: 'needle' },
    { type: 'riddle', prompt: 'What can travel around the world while staying in one corner?', answer: 'stamp' }
];

const games = new Map();
const thumbCache = new Map();
let groqClient = null;

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

function getGroqClient() {
    const apiKey = String(process.env.GROQ_API_KEY || '').trim();
    if (!apiKey) return null;
    if (!groqClient) groqClient = new Groq({ apiKey, dangerouslyAllowBrowser: true });
    return groqClient;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

async function sendCard(sock, chatId, text, thumbUrl, mentions = [], quoted = null, title = 'PuzzleBox', body = 'game update') {
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

function normalize(text) {
    return String(text || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
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

function getRandomPuzzle(usedIndexes) {
    const available = PUZZLES
        .map((item, index) => ({ item, index }))
        .filter(({ index }) => !usedIndexes.has(index));
    const pool = available.length ? available : PUZZLES.map((item, index) => ({ item, index }));
    const picked = pool[Math.floor(Math.random() * pool.length)];
    usedIndexes.add(picked.index);
    return picked.item;
}

function buildLobbyText() {
    return [
        '🧩 PuzzleBox Game Started!',
        '',
        '> Type .join to participate.',
        '> Host can type .start to begin early.',
        '> Game starts in 2m⏳...'
    ].join('\n');
}

function buildRoundText(round, totalRounds, puzzle) {
    return [
        `🧩 Round ${round}/${totalRounds}`,
        '',
        '❓ Puzzle:',
        puzzle.prompt
    ].join('\n');
}

function buildCorrectText(playerJid, points, scoreLines) {
    return [
        `🧾 @${playerJid.split('@')[0]} got it right!`,
        '',
        '➕ +1 point',
        '',
        '📜 Scores:',
        '',
        ...scoreLines
    ].join('\n');
}

function buildNoAnswerText(answer, scoreLines) {
    return [
        `⌛ No one got it.`,
        '',
        `✅ Answer: ${answer}`,
        '',
        '📜 Scores:',
        '',
        ...scoreLines
    ].join('\n');
}

function buildFinalText(ranked) {
    const medals = ['🥇', '🥈', '🥉'];
    const lines = ['🏁 Game Over!', ''];
    ranked.slice(0, 3).forEach((entry, index) => {
        lines.push(`${medals[index]} @${entry.jid.split('@')[0]} - ${entry.points} pts`);
    });
    return lines.join('\n');
}

function getScoreLines(game) {
    return [...game.players.values()]
        .sort((a, b) => b.points - a.points || a.jid.localeCompare(b.jid))
        .map((player) => `@${player.jid.split('@')[0]} - ${player.points}`);
}

async function validateWithGroq(puzzle, userAnswer) {
    const client = getGroqClient();
    if (!client) return null;

    try {
        const completion = await client.chat.completions.create({
            model: String(process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim(),
            temperature: 0,
            max_tokens: 10,
            messages: [
                {
                    role: 'system',
                    content: 'You judge if a user answer correctly solves a puzzle. Reply with only YES or NO.'
                },
                {
                    role: 'user',
                    content: `Puzzle: ${puzzle.prompt}\nExpected answer: ${puzzle.answer}\nUser answer: ${userAnswer}\nIs it correct?`
                }
            ]
        });

        const text = String(completion?.choices?.[0]?.message?.content || '').trim().toUpperCase();
        if (text.startsWith('YES')) return true;
        if (text.startsWith('NO')) return false;
        return null;
    } catch {
        return null;
    }
}

async function isCorrectAnswer(puzzle, rawText) {
    const userAnswer = normalize(rawText);
    const expected = normalize(puzzle.answer);
    if (!userAnswer) return false;
    if (userAnswer === expected) return true;
    if (puzzle.type === 'unscramble' && userAnswer.replace(/\s+/g, '') === expected.replace(/\s+/g, '')) return true;

    const aiResult = await validateWithGroq(puzzle, rawText);
    return Boolean(aiResult);
}

async function startPuzzleBox(sock, chatId, message, senderId) {
    if (!chatId.endsWith('@g.us')) {
        await sock.sendMessage(chatId, { text: 'PuzzleBox is for groups only.' }, { quoted: message });
        return;
    }

    if (games.has(chatId)) {
        await sock.sendMessage(chatId, { text: 'A PuzzleBox game is already running here.' }, { quoted: message });
        return;
    }

    const game = {
        chatId,
        hostId: senderId,
        lobbyOpen: true,
        started: false,
        players: new Map(),
        currentPuzzle: null,
        currentRound: 0,
        totalRounds: TOTAL_ROUNDS,
        usedIndexes: new Set(),
        lobbyTimer: null,
        roundTimer: null
    };

    games.set(chatId, game);

    await sendCard(sock, chatId, buildLobbyText(), ROUND_THUMB_URL, [], message, 'PuzzleBox', 'join before it starts');

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
        runPuzzleBox(sock, chatId).catch((error) => {
            console.error('[puzzlebox] run error:', error?.message || error);
            endPuzzleBox(chatId);
        });
    }, LOBBY_MS);
}

async function joinPuzzleBox(sock, chatId, message, senderId) {
    const game = games.get(chatId);
    if (!game || !game.lobbyOpen || game.started) return false;

    const input = String(message?.message?.conversation || message?.message?.extendedTextMessage?.text || '').trim().toLowerCase();

    // Host can start early with .start
    if (input === '.start') {
        if (senderId !== game.hostId) {
            await sock.sendMessage(chatId, { text: '❌ Only the game host can start the lobby!' }, { quoted: message });
            return true;
        }
        if (game.players.size === 0) {
            await sock.sendMessage(chatId, { text: '❌ Need at least 1 player to start!' }, { quoted: message });
            return true;
        }
        clearTimeout(game.lobbyTimer);
        await runPuzzleBox(sock, chatId);
        return true;
    }

    if (!game.players.has(senderId)) {
        game.players.set(senderId, { jid: senderId, points: 0 });
        await sock.sendMessage(chatId, {
            text: `👥 @${senderId.split('@')[0]} joined the game\n> Total: ${game.players.size} players`,
            mentions: [senderId]
        }, { quoted: message });
    }

    return true;
}

async function handlePuzzleBoxAnswer(sock, chatId, message, senderId, rawText) {
    const game = games.get(chatId);
    if (!game || !game.started || !game.currentPuzzle || !game.players.has(senderId)) return false;
    if (game.currentPuzzle.answered) return false;

    const correct = await isCorrectAnswer(game.currentPuzzle.puzzle, rawText);
    if (!correct) return false;

    game.currentPuzzle.answered = true;
    clearTimeout(game.roundTimer);
    game.players.get(senderId).points += 1;

    const scoreLines = getScoreLines(game);
    await sendCard(
        sock,
        chatId,
        buildCorrectText(senderId, 1, scoreLines),
        CORRECT_THUMB_URL,
        [...game.players.keys()],
        message,
        'PuzzleBox',
        'correct answer'
    );

    if (typeof game.currentPuzzle.resolveRound === 'function') {
        game.currentPuzzle.resolveRound();
    }

    return true;
}

async function waitForRound(game) {
    await new Promise((resolve) => {
        game.currentPuzzle.resolveRound = resolve;
        game.roundTimer = setTimeout(resolve, ROUND_MS);
    });
}

async function runPuzzleBox(sock, chatId) {
    const game = games.get(chatId);
    if (!game) return;

    game.lobbyOpen = false;
    game.started = true;

    if (game.players.size === 0) {
        await sock.sendMessage(chatId, { text: 'PuzzleBox cancelled. No one joined.' });
        endPuzzleBox(chatId);
        return;
    }

    for (let round = 1; round <= game.totalRounds; round++) {
        const activeGame = games.get(chatId);
        if (!activeGame) return;

        const puzzle = getRandomPuzzle(activeGame.usedIndexes);
        activeGame.currentRound = round;
        activeGame.currentPuzzle = {
            puzzle,
            answered: false,
            resolveRound: null
        };

        await sendCard(
            sock,
            chatId,
            buildRoundText(round, activeGame.totalRounds, puzzle),
            ROUND_THUMB_URL,
            [],
            null,
            'PuzzleBox',
            `round ${round} started`
        );

        await waitForRound(activeGame);

        const latest = games.get(chatId);
        if (!latest) return;

        if (!latest.currentPuzzle.answered) {
            await sock.sendMessage(chatId, {
                text: buildNoAnswerText(puzzle.answer, getScoreLines(latest)),
                mentions: [...latest.players.keys()]
            });
        }

        latest.currentPuzzle = null;
        latest.roundTimer = null;

        if (round < latest.totalRounds) {
            await sleep(1200);
        }
    }

    const ranked = [...game.players.values()]
        .sort((a, b) => b.points - a.points || a.jid.localeCompare(b.jid));

    const topScore = ranked[0]?.points || 0;
    if (topScore > 0) {
        ranked.filter((entry) => entry.points === topScore).forEach((entry) => {
            addBalance(entry.jid, WIN_REWARD, { awardXp: false });
            progressMission(entry.jid, 'challenge');
        });
    }

    await sendCard(
        sock,
        chatId,
        `${buildFinalText(ranked)}\n\n> 💴 Winners got ¥${WIN_REWARD}`,
        CORRECT_THUMB_URL,
        ranked.slice(0, 3).map((entry) => entry.jid),
        null,
        'PuzzleBox',
        'final result'
    );

    endPuzzleBox(chatId);
}

function endPuzzleBox(chatId) {
    const game = games.get(chatId);
    if (!game) return;
    clearTimeout(game.lobbyTimer);
    clearTimeout(game.roundTimer);
    games.delete(chatId);
}

function isPuzzleBoxParticipant(chatId, senderId) {
    const game = games.get(chatId);
    if (!game) return false;
    return game.players.has(senderId);
}

module.exports = {
    startPuzzleBox,
    joinPuzzleBox,
    handlePuzzleBoxAnswer,
    isPuzzleBoxParticipant
};
