const { addBalance, progressMission } = require('../../lib/economy');
const axios = require('axios');
const Groq = require('groq-sdk');

const LOBBY_MS = 30 * 1000;
const ROUND_MS = 15 * 1000;
const ROUND_REVEAL_DELAY_MS = 2 * 1000;
const ROUND_RESULT_DELAY_MS = 2500;
const BETWEEN_ROUND_DELAY_MS = 3500;
const ROUND_POINTS = 10;
const FINAL_REWARDS = [120, 70, 40];
const WORD_MODEL = 'llama-3.1-8b-instant';
const RECENT_WORD_HISTORY = 40;

const WORD_BANK = [
    { answer: 'cat',   emoji: '🐱' },
    { answer: 'dog',   emoji: '🐶' },
    { answer: 'sun',   emoji: '☀️' },
    { answer: 'moon',  emoji: '🌙' },
    { answer: 'star',  emoji: '⭐' },
    { answer: 'fish',  emoji: '🐟' },
    { answer: 'bird',  emoji: '🐦' },
    { answer: 'tree',  emoji: '🌳' },
    { answer: 'book',  emoji: '📘' },
    { answer: 'milk',  emoji: '🥛' },
    { answer: 'cake',  emoji: '🎂' },
    { answer: 'rice',  emoji: '🍚' },
    { answer: 'fire',  emoji: '🔥' },
    { answer: 'water', emoji: '💧' },
    { answer: 'earth', emoji: '🌍' },
    { answer: 'cloud', emoji: '☁️' },
    { answer: 'apple', emoji: '🍎' },
    { answer: 'grape', emoji: '🍇' },
    { answer: 'stone', emoji: '🪨' },
    { answer: 'horse', emoji: '🐎' },
];

const START_THUMB_URL = 'https://files.catbox.moe/g9vyzn.png';
const CORRECT_THUMB_URL = 'https://files.catbox.moe/dir2ud.png';

const games = new Map();
let groqClient = null;
const recentWords = [];

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function shuffleWord(word) {
    const original = String(word || '');
    const chars = original.split('');
    if (chars.length < 2) return original;

    let scrambled = original;
    while (scrambled.toLowerCase() === original.toLowerCase()) {
        for (let i = chars.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [chars[i], chars[j]] = [chars[j], chars[i]];
        }
        scrambled = chars.join('');
    }
    return scrambled;
}

function normalizeAnswer(text) {
    return String(text || '').trim().toLowerCase();
}

function capitalize(text) {
    const raw = String(text || '');
    return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : raw;
}

function getRoundCount(playerCount) {
    if (playerCount === 2) return 3;
    if (playerCount > 2) return 6;
    return 7;
}

function getRandomWord(usedAnswers) {
    const available = WORD_BANK.filter((item) => !usedAnswers.has(item.answer));
    const pool = available.length ? available : WORD_BANK;
    return pool[Math.floor(Math.random() * pool.length)];
}

function getGroqClient() {
    const apiKey = String(process.env.GROQ_API_KEY || '').trim();
    if (!apiKey) return null;
    if (!groqClient) groqClient = new Groq({ apiKey, dangerouslyAllowBrowser: true });
    return groqClient;
}

function sanitizeWord(raw) {
    return String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z]/g, '');
}

function fallbackWords(count, usedAnswers) {
    const picked = [];
    const usedNow = new Set([...usedAnswers, ...recentWords]);

    while (picked.length < count) {
        const word = getRandomWord(usedNow);
        if (!word?.answer) break;
        usedNow.add(word.answer);
        picked.push({ answer: word.answer, emoji: word.emoji || '📝' });
    }

    return picked;
}

async function fetchGroqWords(count, usedAnswers) {
    const client = getGroqClient();
    if (!client) return fallbackWords(count, usedAnswers);

    try {
        const completion = await client.chat.completions.create({
            model: WORD_MODEL,
            temperature: 1,
            max_tokens: 120,
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content: [
                        'Return strict JSON only.',
                        'Generate random simple English words for a word scramble game.',
                        'Use lowercase only.',
                        'Each word must be a single common noun with 4 to 8 letters.',
                        'No spaces, no hyphens, no duplicates, no profanity.'
                    ].join(' ')
                },
                {
                    role: 'user',
                    content: JSON.stringify({
                        count,
                        exclude: [...usedAnswers],
                        format: { words: ['example'] }
                    })
                }
            ]
        });

        const content = completion?.choices?.[0]?.message?.content;
        const parsed = content ? JSON.parse(content) : null;
        const words = Array.isArray(parsed?.words) ? parsed.words : [];

        const sanitized = [];
        const seen = new Set([...usedAnswers]);

        for (const item of words) {
            const answer = sanitizeWord(item);
            if (!answer || answer.length < 4 || answer.length > 8) continue;
            if (seen.has(answer)) continue;
            seen.add(answer);
            sanitized.push({ answer, emoji: '📝' });
            if (sanitized.length >= count) break;
        }

        if (sanitized.length >= count) return sanitized;

        return [...sanitized, ...fallbackWords(count - sanitized.length, seen)];
    } catch (error) {
        console.error('[wordquest] groq word generation failed:', error?.message || error);
        return fallbackWords(count, usedAnswers);
    }
}

async function ensureQueuedWords(game, minimumCount = 1) {
    if (!Array.isArray(game.queuedWords)) game.queuedWords = [];
    if (game.queuedWords.length >= minimumCount) return;

    const needed = Math.max(minimumCount - game.queuedWords.length, 4);
    const exclude = new Set([
        ...game.usedAnswers,
        ...game.queuedWords.map((item) => item.answer),
        ...recentWords
    ]);

    const newWords = await fetchGroqWords(needed, exclude);
    game.queuedWords.push(...newWords);
}

function rememberWord(answer) {
    const normalized = sanitizeWord(answer);
    if (!normalized) return;
    recentWords.push(normalized);
    while (recentWords.length > RECENT_WORD_HISTORY) {
        recentWords.shift();
    }
}

async function getThumbBuffer(url) {
    try {
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
        return Buffer.from(res.data);
    } catch {
        return null;
    }
}

async function sendWithThumb(sock, chatId, text, mentions, title, body, thumbUrl = START_THUMB_URL) {
    const thumbnail = await getThumbBuffer(thumbUrl);

    const extra = thumbnail ? {
        contextInfo: {
            externalAdReply: {
                title,
                body,
                thumbnail,
                mediaType: 1,
                mediaUrl: '',
                showAdAttribution: 0,
                renderLargerThumbnail: false
            }
        }
    } : {};

    await sock.sendMessage(chatId, { text, mentions, ...extra });
}

// ── Text builders ────────────────────────────────────────────

function buildLobbyText(playerCount, totalRounds) {
    return [
        '┃ 📤 *ᴡᴏʀᴅ Qᴜᴇꜱᴛ*',
        '┃ ───────',
        `┃ ✧ ʀᴏᴜɴᴅꜱ: ${totalRounds}`,
        `┃ ✧ ᴘʟᴀʏᴇʀꜱ: ${playerCount}`,
        '┃ ───────',
        '> 💥 *ᴛʏᴘᴇ .join ᴛᴏ ᴘᴀʀᴛɪᴄɪᴘᴀᴛᴇ...*',
        '> ⏳ *ɢᴀᴍᴇ ꜱᴛᴀʀᴛꜱ ɪɴ 30ꜱ*'
    ].join('\n');
}

function buildJoinText(playerJid, totalPlayers, totalRounds) {
    return [
        '┃ 💥 *ᴘʟᴀʏᴇʀ ᴊᴏɪɴᴇᴅ!*',
        '┃ ───────',
        `┃ ✧ @${playerJid.split('@')[0]} joined the game`,
        `┃ ✧ ᴛᴏᴛᴀʟ: ${totalPlayers} players`,
        `┃ ✧ ʀᴏᴜɴᴅꜱ: ${totalRounds}`,
        '┃ ───────'
    ].join('\n');
}

function buildRoundText(roundNumber, totalRounds, scrambled) {
    return [
        `┃ 📤 *ʀᴏᴜɴᴅ ${roundNumber} / ${totalRounds}*`,
        '┃ ───────',
        '┃ 🔀 ᴜɴꜱᴄʀᴀᴍʙʟᴇ:',
        `┃ ➤ "${scrambled}"`,
        '┃ ───────',
        '> ⚡ *ꜰɪʀꜱᴛ ᴄᴏʀʀᴇᴄᴛ ᴀɴꜱᴡᴇʀ ᴡɪɴꜱ!*'
    ].join('\n');
}

function buildRoundWinnerText(playerJid, answer, emoji) {
    return [
        '┃ 🏆 *ʀᴏᴜɴᴅ ᴡɪɴɴᴇʀ*',
        '┃ ───────',
        `┃ ✧ @${playerJid.split('@')[0]} answered: ${capitalize(answer)}${emoji ? ` ${emoji}` : ''}`,
        `┃ ✧ +${ROUND_POINTS} points`,
        '┃ ───────'
    ].join('\n');
}

function buildNoAnswerText(answer, emoji) {
    return [
        '┃ ⏰ *ɴᴏ ᴏɴᴇ ᴀɴꜱᴡᴇʀᴇᴅ*',
        '┃ ───────',
        `┃ ✧ ᴄᴏʀʀᴇᴄᴛ: ${capitalize(answer)}${emoji ? ` ${emoji}` : ''}`,
        '┃ ───────'
    ].join('\n');
}

function buildFinalText(rankedPlayers) {
    const lines = [
        '┃ 🎖 *ɢᴀᴍᴇ ᴏᴠᴇʀ*',
        '┃ ───────'
    ];
    rankedPlayers.slice(0, 3).forEach((entry, index) => {
        const medal = ['🥇', '🥈', '🥉'][index];
        lines.push(`┃ ${medal} @${entry.jid.split('@')[0]} → ${entry.points} pts`);
    });
    lines.push('┃ ───────');
    lines.push('> 💴 *ʀᴇᴡᴀʀᴅ ɢɪᴠᴇɴ!*');
    return lines.join('\n');
}

// ── Game logic ───────────────────────────────────────────────

async function startWordQuest(sock, chatId, message, senderId) {
    if (games.has(chatId)) {
        await sock.sendMessage(chatId, {
            text: 'A word quest game is already running here.'
        }, { quoted: message });
        return;
    }

    const game = {
        chatId,
        hostId: senderId,
        lobbyOpen: true,
        started: false,
        players: new Map(),
        round: 0,
        totalRounds: 7,
        currentRound: null,
        usedAnswers: new Set(),
        queuedWords: [],
        lobbyTimer: null,
        roundTimer: null
    };

    games.set(chatId, game);

    await sendWithThumb(
        sock, chatId,
        buildLobbyText(0, game.totalRounds),
        [],
        'ᴡᴏʀᴅ Qᴜᴇꜱᴛ',
        'ᴛʏᴘᴇ .join ᴛᴏ ᴘʟᴀʏ 🎮',
        START_THUMB_URL
    );

    game.lobbyTimer = setTimeout(() => {
        runGame(sock, chatId).catch((err) => {
            console.error('[wordquest] runGame error:', err?.message || err);
            endGame(chatId);
        });
    }, LOBBY_MS);
}

async function joinWordQuest(sock, chatId, message, senderId) {
    const game = games.get(chatId);
    if (!game || !game.lobbyOpen || game.started) return false;

    if (!game.players.has(senderId)) {
        game.players.set(senderId, { jid: senderId, points: 0 });
        game.totalRounds = getRoundCount(game.players.size);

        await sock.sendMessage(chatId, {
            text: buildJoinText(senderId, game.players.size, game.totalRounds),
            mentions: [senderId]
        }, { quoted: message });
    }

    return true;
}

async function handleWordQuestAnswer(sock, chatId, message, senderId, rawText) {
    const game = games.get(chatId);
    if (!game || !game.started || !game.currentRound || game.currentRound.answered) return false;
    if (!game.players.has(senderId)) return false;

    const normalized = normalizeAnswer(rawText);
    if (!normalized || normalized !== game.currentRound.answer) return false;

    game.currentRound.answered = true;
    clearTimeout(game.roundTimer);

    game.players.get(senderId).points += ROUND_POINTS;

    await sock.sendMessage(chatId, {
        text: buildRoundWinnerText(senderId, game.currentRound.answer, game.currentRound.emoji),
        mentions: [senderId],
        ...(await (async () => {
            const thumbnail = await getThumbBuffer(CORRECT_THUMB_URL);
            return thumbnail ? {
                contextInfo: {
                    externalAdReply: {
                        title: 'Word Quest',
                        body: 'correct answer',
                        thumbnail,
                        mediaType: 1,
                        mediaUrl: '',
                        showAdAttribution: 0,
                        renderLargerThumbnail: false
                    }
                }
            } : {};
        })())
    }, { quoted: message });

    if (typeof game.currentRound.resolveRound === 'function') {
        game.currentRound.resolveRound();
    }

    return true;
}

async function waitForRoundFinish(gameRef) {
    await new Promise((resolve) => {
        gameRef.currentRound.resolveRound = resolve;
        gameRef.roundTimer = setTimeout(resolve, ROUND_MS);
    });
}

async function runGame(sock, chatId) {
    const game = games.get(chatId);
    if (!game) return;

    game.lobbyOpen = false;
    game.started = true;

    if (game.players.size === 0) {
        await sock.sendMessage(chatId, {
            text: 'Word Quest cancelled. No one joined the lobby.'
        });
        endGame(chatId);
        return;
    }

    game.totalRounds = getRoundCount(game.players.size);
    await ensureQueuedWords(game, game.totalRounds);

    for (let round = 1; round <= game.totalRounds; round++) {
        const gameRef = games.get(chatId);
        if (!gameRef) return;

        await ensureQueuedWords(gameRef, 1);
        const word = gameRef.queuedWords.shift() || getRandomWord(gameRef.usedAnswers);
        gameRef.usedAnswers.add(word.answer);
        rememberWord(word.answer);
        gameRef.round = round;
        gameRef.currentRound = {
            answer: normalizeAnswer(word.answer),
            emoji: word.emoji,
            answered: false,
            resolveRound: null
        };

        await sock.sendMessage(chatId, {
            text: buildRoundText(round, gameRef.totalRounds, shuffleWord(word.answer))
        });

        await sleep(ROUND_REVEAL_DELAY_MS);
        await waitForRoundFinish(gameRef);

        const latest = games.get(chatId);
        if (!latest) return;

        if (!latest.currentRound?.answered) {
            await sock.sendMessage(chatId, {
                text: buildNoAnswerText(word.answer, word.emoji)
            });
        }

        latest.currentRound = null;
        latest.roundTimer = null;

        await sleep(ROUND_RESULT_DELAY_MS);
        if (round < latest.totalRounds) await sleep(BETWEEN_ROUND_DELAY_MS);
    }

    const rankedPlayers = [...game.players.values()]
        .sort((a, b) => b.points - a.points || a.jid.localeCompare(b.jid));

    rankedPlayers.slice(0, 3).forEach((entry, index) => {
        const reward = FINAL_REWARDS[index] || 0;
        if (reward > 0) {
            addBalance(entry.jid, reward, { awardXp: false });
            progressMission(entry.jid, 'challenge');
        }
        entry.reward = reward;
    });

    await sendWithThumb(
        sock, chatId,
        buildFinalText(rankedPlayers),
        rankedPlayers.slice(0, 3).map((e) => e.jid),
        'ɢᴀᴍᴇ ᴏᴠᴇʀ 🎖',
        'ʀᴇᴡᴀʀᴅꜱ ᴅɪꜱᴛʀɪʙᴜᴛᴇᴅ 💴'
    );

    endGame(chatId);
}

function endGame(chatId) {
    const game = games.get(chatId);
    if (!game) return;
    clearTimeout(game.lobbyTimer);
    clearTimeout(game.roundTimer);
    games.delete(chatId);
}

function isWordQuestParticipant(chatId, senderId) {
    const game = games.get(chatId);
    if (!game) return false;
    return game.players.has(senderId);
}

module.exports = { startWordQuest, joinWordQuest, handleWordQuestAnswer, isWordQuestParticipant };
