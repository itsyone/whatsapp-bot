/**
 * Truth or Dare Game
 * - 60s lobby
 * - Current player picks a target
 * - Target chooses truth or dare
 * - Voice notes for dare proof are transcribed via Groq Whisper
 * - Elimination on skip/no/timeout
 * - Admin start = hidetag mention, normal user = no hidetag
 */

const fs = require('fs');
const path = require('path');
const Groq = require('groq-sdk');
const { downloadContentFromMessage } = require('../../lib/baileys');
const { getBuffer } = require('../../lib/myfunc');

// ─── Persistence ──────────────────────────────────────────────────────────────
const TOD_SAVE_PATH = path.join(process.cwd(), 'data', 'tod_state.json');

function serializeGame(game) {
    return {
        chatId: game.chatId,
        players: [...game.players],
        started: game.started,
        lobbyOpen: false, // on restore lobby is always closed
        turnIndex: game.turnIndex,
        state: game.state,
        currentPlayer: game.currentPlayer,
        currentTarget: game.currentTarget,
        currentQuestion: game.currentQuestion,
        currentType: game.currentType,
        stateChangedAt: game.stateChangedAt || Date.now(),
        votes: { yes: game.votes.yes, no: game.votes.no, voters: [...game.votes.voters] },
        usedTruths: [...(game.usedTruths || [])],
        usedDares: [...(game.usedDares || [])],
    };
}

function deserializeGame(data) {
    return {
        chatId: data.chatId,
        players: data.players || [],
        started: !!data.started,
        lobbyOpen: false,
        turnIndex: data.turnIndex || 0,
        state: data.state || 'wait_target',
        currentPlayer: data.currentPlayer || null,
        currentTarget: data.currentTarget || null,
        currentQuestion: data.currentQuestion || null,
        currentType: data.currentType || null,
        stateChangedAt: data.stateChangedAt || Date.now(),
        votes: { yes: data.votes?.yes || 0, no: data.votes?.no || 0, voters: new Set(data.votes?.voters || []) },
        usedTruths: new Set(data.usedTruths || []),
        usedDares: new Set(data.usedDares || []),
        timer: null,
    };
}

function saveGames() {
    try {
        if (!fs.existsSync(path.dirname(TOD_SAVE_PATH))) {
            fs.mkdirSync(path.dirname(TOD_SAVE_PATH), { recursive: true });
        }
        const obj = {};
        for (const [chatId, game] of games) {
            if (game.started) obj[chatId] = serializeGame(game);
        }
        fs.writeFileSync(TOD_SAVE_PATH, JSON.stringify(obj, null, 2));
    } catch (e) {
        console.error('[TOD] save error:', e.message);
    }
}

function endGame(chatId) {
    const game = games.get(chatId);
    if (game?.timer) clearTimeout(game.timer);
    games.delete(chatId);
    saveGames();
}

function loadSavedGames() {
    try {
        if (!fs.existsSync(TOD_SAVE_PATH)) return;
        const raw = JSON.parse(fs.readFileSync(TOD_SAVE_PATH, 'utf8'));
        for (const [chatId, data] of Object.entries(raw)) {
            if (!games.has(chatId)) {
                games.set(chatId, deserializeGame(data));
                console.log(`[TOD] Restored game for ${chatId} in state=${data.state}`);
            }
        }
    } catch (e) {
        console.error('[TOD] load error:', e.message);
    }
}

// Restore timers after bot reconnect — call this from main.js after sock is ready
async function restoreGameTimers(sock) {
    const GRACE = 60 * 1000; // give 60s fresh grace for any waiting state
    const MAX_STALE_RESTORE = 2 * 60 * 60 * 1000; // 2 hours

    for (const [chatId, game] of games) {
        if (!game.started || game.timer) continue;

        const elapsed = Date.now() - (game.stateChangedAt || Date.now());
        
        // If the game state is more than 2 hours old, just kill it
        if (elapsed > MAX_STALE_RESTORE) {
            console.log(`[TOD] Discarding stale game for ${chatId} (last active ${Math.round(elapsed/60000)}m ago)`);
            endGame(chatId);
            continue;
        }

        const remaining = Math.max(5000, GRACE - elapsed);

        if (game.state === 'voting') {
            game.timer = setTimeout(() => resolveTruthVote(sock, chatId), 3000);
        } else if (['wait_target', 'wait_choice', 'wait_truth_answer', 'wait_dare_proof'].includes(game.state)) {
            const player = game.currentTarget || game.currentPlayer;
            // Announce resume
            await sock.sendMessage(chatId, {
                text: `⚡ *Game resumed after restart!*\n> ${player ? tag(player) + ' still needs to respond.' : 'Continuing...'}\n> ⏳ ${Math.round(remaining/1000)}s remaining.`,
                mentions: player ? [player] : []
            }).catch(() => {});

            game.timer = setTimeout(async () => {
                const g = games.get(chatId);
                if (!g) return;
                const victim = g.currentTarget || g.currentPlayer;
                if (victim) {
                    await sock.sendMessage(chatId, {
                        text: `⏳ Time's up after restart. ${tag(victim)} ❌ *eliminated*.`,
                        mentions: [victim]
                    }).catch(() => {});
                    eliminatePlayer(sock, chatId, victim);
                } else {
                    nextTurn(sock, chatId);
                }
            }, remaining);
        }
    }
}

// ─── Timing ──────────────────────────────────────────────────────────────────
const LOBBY_MS   = 60 * 1000;
const CHOICE_MS  = 20 * 1000;
const TARGET_MS  = 20 * 1000;
const ANSWER_MS  = 45 * 1000;
const PROOF_MS   = 30 * 1000;
const VOTE_MS    = 10 * 1000;
const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;

// ─── Thumbs ───────────────────────────────────────────────────────────────────
const THUMB = {
    start:  'https://i.ibb.co/Jw43mDXH/51dac542-a89e-4111-9382-05d9a82b4cd6-removalai-preview.png',
    choice: 'https://i.ibb.co/gLrYNXCL/2ec792fb-9769-4553-8c89-f719968ac286-removalai-preview.png',
    truth:  'https://i.ibb.co/93c10xmn/d2046aff-fdc0-4c53-85c9-210abd94c1c6-removalai-preview.png',
    dare:   'https://i.ibb.co/gLrYNXCL/2ec792fb-9769-4553-8c89-f719968ac286-removalai-preview.png',
    win:    'https://i.ibb.co/twmrPJ7p/861a058e-c6d3-467c-9198-8401be431814-removalai-preview.png',
};
const thumbCache = new Map();

// ─── Active games (global so hot-reload doesn't wipe them) ───────────────────
if (!global.__todGames) global.__todGames = new Map();
const games = global.__todGames;

// ─── Stale Cleanup ──────────────────────────────────────────────────────────
const STALE_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 mins
const MAX_INACTIVITY_MS = 60 * 60 * 1000; // 1 hour

function startStaleCleanup(sock) {
    if (global.__todCleanupStarted) return;
    global.__todCleanupStarted = true;

    setInterval(async () => {
        const now = Date.now();
        for (const [chatId, game] of games) {
            const lastActive = game.stateChangedAt || game.createdAt || now;
            if (now - lastActive > MAX_INACTIVITY_MS) {
                console.log(`[TOD] Cleaning up stale game in ${chatId}`);
                if (sock) {
                    try {
                        await sock.sendMessage(chatId, { text: '⏳ *Truth or Dare ended due to 1 hour of inactivity.*' });
                    } catch {}
                }
                endGame(chatId);
                saveGames();
            }
        }
    }, STALE_CLEANUP_INTERVAL);
}

// ─── Groq client ─────────────────────────────────────────────────────────────
let _groq = null;
function getGroqClient() {
    const key = String(process.env.GROQ_API_KEY || '').trim();
    if (!key) return null;
    if (!_groq) _groq = new Groq({ apiKey: key }); // FIXED: removed dangerouslyAllowBrowser
    return _groq;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
/** Strip @suffix and :device — makes @s.whatsapp.net and @lid compare equal */
function normalizeJid(jid) {
    if (!jid) return '';
    // Extract the ID part (before @ and before :)
    // Phone numbers stay numbers, LIDs stay alphanumeric
    return String(jid).split('@')[0].split(':')[0].trim();
}
function jidMatch(a, b) {
    const na = normalizeJid(a);
    const nb = normalizeJid(b);
    return na && nb && na === nb;
}
function findInPlayers(players, jid) {
    return players.find(p => jidMatch(p, jid)) || null;
}

function tag(jid) { return `@${String(jid || '').split('@')[0]}`; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getThumbBuf(url) {
    if (!thumbCache.has(url)) {
        try {
            const buf = await getBuffer(url);
            thumbCache.set(url, buf || null);
        } catch { thumbCache.set(url, null); }
    }
    return thumbCache.get(url) || null;
}

/**
 * Send a card message using the exact payload format provided by the user.
 * No sourceUrl, renderLargerThumbnail = false.
 */
async function sendCard(sock, chatId, text, thumbKey, mentions = [], quoted = null, title = '', body = '') {
    const payload = { text, mentions };
    const opts = quoted ? { quoted } : {};
    await sock.sendMessage(chatId, payload, opts);
}

// ─── AI content generation ────────────────────────────────────────────────────
const FALLBACKS = {
    truth: [
        'Who in this group do you secretly have a crush on?',
        'What is the most embarrassing thing you\'ve done this year?',
        'What lie have you told that almost got you caught?',
        'What\'s the most embarrassing text you\'ve ever sent by accident?',
        'Have you ever faked being sick to avoid someone in this group?',
        'Who here do you think is the most overrated?',
        'What\'s the pettiest thing you\'ve ever done?',
        'What\'s a secret you\'ve kept from your parents?',
        'Have you ever ghosted someone? Who?',
        'What\'s the most cringe thing on your camera roll right now?',
        'Have you ever blamed someone else for something you did?',
        'Who do you find most annoying in this group and why?',
    ],
    dare: [
        'Send a 10-second voice note singing your country\'s national anthem.',
        'Change your WhatsApp about to "I lost a dare" for 30 mins.',
        'Send a voice note saying "I am the biggest clown in this group".',
        'Change your display name to something embarrassing for 15 minutes.',
        'Send a voice note complimenting every person in this group one by one.',
        'Send your most recent selfie in this chat.',
        'Voice note: say "I love drama" three times dramatically.',
        'Tag someone random and say something nice about them.',
        'Send a voice note of you rapping for 10 seconds.',
        'Change your status to "I failed a dare" for 1 hour.',
        'Send a voice note imitating someone in the group (don\'t say who).',
        'Forward the last meme you saved to this group.',
    ]
};

async function generateQuestion(type, targetTag, usedSet = new Set(), round = 1) {
    const groq = getGroqClient();
    if (!groq) {
        return `> *${type === 'truth' ? 'What is your biggest secret?' : 'Send a banana emoji to a random person in the group.'}*`;
    }

    try {
        const usedList = Array.from(usedSet).slice(-20).join(', ');
        
        const systemPrompt = type === 'truth'
            ? `You are a Truth or Dare game engine. Generate a UNIQUE, engaging, and spicy TRUTH question.
               RULES:
               - TARGET: ${targetTag}
               - LENGTH: STRICTLY between 5 and 15 words.
               - OUTPUT: ONLY the question text. NO intro, NO quotes, NO explanation.
               - AVOID: ${usedList}
               - Focus on secrets, crushes, embarrassing moments, or controversial opinions.`
            : `You are a Truth or Dare game engine. Generate a UNIQUE, social, and interactive DARE.
               RULES:
               - TARGET: ${targetTag}
               - OUTPUT: ONLY the dare text. NO intro, NO quotes, NO explanation.
               - AVOID: ${usedList}
               - LENGTH: STRICTLY between 5 and 20 words. Keep it short and punchy.
               - NEVER include fake phone numbers, JIDs, or random IDs like @123456789. Only use "someone", "a friend", "the group", etc.
               - Make it SOCIAL and INTERACTIVE: tag someone, send emojis, do face reveals, flirt, confess feelings.
               - Examples: "send banana emoji to your friend", "tag someone and tell its your crush", "do a face reveal", "flirt with someone until they accept or decline", "send your most recent selfie", "change your display name to something embarrassing".`;

        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: 'system', content: systemPrompt }],
            model: 'llama-3.3-70b-versatile',
            temperature: 0.9,
            max_tokens: 80,
        });

        let q = chatCompletion.choices[0]?.message?.content?.trim() || '';
        q = q.replace(/^["']|["']$/g, ''); // strip AI quotes
        
        if (q) {
            usedSet.add(q);
            return `> *${q}*`;
        }
    } catch (error) {
        console.error('[tod] AI error:', error);
    }
    
    return `> *${type === 'truth' ? 'What is your biggest secret?' : 'Send a banana emoji to a random person in the group.'}*`;
}

// ─── Voice transcription for dare proof ───────────────────────────────────────
async function transcribeAudio(audioMsg) {
    const groq = getGroqClient();
    // ... rest of the code remains the same ...
    if (!groq) return null;
    try {
        const stream = await downloadContentFromMessage(audioMsg, 'audio');
        const chunks = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        const buf = Buffer.concat(chunks);
        if (!buf.length) return null;
        const mime = audioMsg.mimetype || '';
        let ext = 'ogg';
        if (mime.includes('mp3') || mime.includes('mpeg')) ext = 'mp3';
        else if (mime.includes('wav')) ext = 'wav';
        else if (mime.includes('webm')) ext = 'webm';
        else if (mime.includes('mp4') || mime.includes('m4a')) ext = 'm4a';
        const file = await Groq.toFile(buf, `dare_proof.${ext}`);
        const result = await groq.audio.transcriptions.create({
            file,
            model: String(process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3-turbo').trim(),
            temperature: 0,
            response_format: 'json'
        });
        return String(result?.text || '').trim() || null;
    } catch (e) {
        console.error('[TOD Transcribe]', e.message);
        return null;
    }
}

// ─── Validation keywords ──────────────────────────────────────────────────────
const SKIP_WORDS = ['no', 'skip', 'pass', 'nahi', 'nope', 'refuse', 'nah', 'na'];
function isSkipping(text) {
    return SKIP_WORDS.includes(text.toLowerCase().trim());
}

// ─── Game flow ────────────────────────────────────────────────────────────────
async function startTruthOrDare(sock, chatId, message, senderId, senderIsAdmin) {
    if (!chatId.endsWith('@g.us')) {
        await sock.sendMessage(chatId, { text: '❌ Truth or Dare is for groups only.' }, { quoted: message });
        return;
    }
    const existing = games.get(chatId);
    if (existing) {
        const lastActive = existing.stateChangedAt || existing.createdAt || Date.now();
        if (Date.now() - lastActive > MAX_INACTIVITY_MS) {
            console.log(`[TOD] Discarding stale game in ${chatId} to start new one`);
            endGame(chatId);
        } else {
            await sock.sendMessage(chatId, { text: '⚠️ A game is already running. Wait for it to finish or type `.tod stop`.' }, { quoted: message });
            return;
        }
    }

    const game = {
        chatId,
        hostId: senderId,
        players: [senderId],
        started: false,
        lobbyOpen: true,
        turnIndex: 0,
        state: 'lobby',
        currentPlayer: null,
        currentTarget: null,
        currentQuestion: null,
        currentType: null,
        round: 1,
        timer: null,
        stateChangedAt: Date.now(),
        votes: { yes: 0, no: 0, voters: new Set() },
        usedTruths: new Set(),
        usedDares: new Set(),
    };
    games.set(chatId, game);

    // Build lobby text
    const lobbyText = [
        '🎮 *Truth or Dare has started!*',
        '',
        '> Everyone who wants to play, type:',
        '> *.join*',
        '',
        '> Host can type *.start* to begin early.',
        '> ⏳ You have 60 seconds to join.',
    ].join('\n');

    if (senderIsAdmin) {
        // Hidetag — mention all group members silently
        try {
            const meta = await sock.groupMetadata(chatId);
            const allJids = (meta.participants || []).map(p => p.id).filter(Boolean);
            const logo = await getThumbBuf(THUMB.start);
            const adon = { title: '🎮 Truth or Dare', body: 'Type .join to enter the game!', thumbnail: logo, mediaType: 1, mediaUrl: '', sourceUrl: '', showAdAttribution: 0, renderLargerThumbnail: false };
            await sock.sendMessage(chatId, { text: lobbyText, mentions: allJids, contextInfo: { externalAdReply: adon } });
        } catch {
            await sendCard(sock, chatId, lobbyText, 'start', [senderId], null, '🎮 Truth or Dare', 'Type .join to enter!');
        }
    } else {
        await sendCard(sock, chatId, lobbyText, 'start', [senderId], null, '🎮 Truth or Dare', 'Type .join to enter!');
    }

    // ✅ Confirm starter joined
    await sock.sendMessage(chatId, {
        text: `✅ ${tag(senderId)} joined the game.\n> Current players: 1`,
        mentions: [senderId]
    });

    game.timer = setTimeout(() => lockAndRun(sock, chatId), LOBBY_MS);
}

async function joinTruthOrDare(sock, chatId, message, senderId) {
    const game = games.get(chatId);
    if (!game) return false;
    if (!game.lobbyOpen) return false;

    const input = String(message?.message?.conversation || message?.message?.extendedTextMessage?.text || '').trim().toLowerCase();
    
    // Immediate start logic
    if (input === '.start') {
        if (!jidMatch(game.hostId, senderId)) {
            await sock.sendMessage(chatId, { text: '❌ Only the game host can start the lobby!' }, { quoted: message });
            return true;
        }
        if (game.players.length < 2) {
            await sock.sendMessage(chatId, { text: '❌ Need at least 2 players to start!' }, { quoted: message });
            return true;
        }
        clearTimeout(game.timer);
        await lockAndRun(sock, chatId);
        return true;
    }

    if (input !== '.join') return false;

    if (findInPlayers(game.players, senderId)) return true;   // already in
    if (game.players.length >= MAX_PLAYERS) {
        await sock.sendMessage(chatId, { text: '⚠️ Game is full!' });
        return true;
    }
    game.players.push(senderId);
    await sock.sendMessage(chatId, {
        text: `✅ ${tag(senderId)} joined the game.\n> Current players: ${game.players.length}`,
        mentions: [senderId]
    });
    return true;
}

async function lockAndRun(sock, chatId) {
    const game = games.get(chatId);
    if (!game) return;
    game.lobbyOpen = false;

    if (game.players.length < MIN_PLAYERS) {
        await sock.sendMessage(chatId, { text: `❌ Not enough players (need at least ${MIN_PLAYERS}). Game cancelled.` });
        endGame(chatId);
        return;
    }

    game.started = true;
    const list = game.players.map(p => tag(p)).join('  ');
    await sock.sendMessage(chatId, {
        text: `🧩 *Lobby locked. Game starting!*\n\n*Players:*\n${list}\n\n> Let's go 🔥`,
        mentions: game.players
    });

    await sleep(2000);
    nextTurn(sock, chatId);
}

async function nextTurn(sock, chatId) {
    const game = games.get(chatId);
    if (!game) return;

    if (game.players.length < 1) {
        await sendCard(sock, chatId, '🏁 *Game over — no players left!*', 'win', [], null, '🏁 Game Over', 'Nobody survived!');
        endGame(chatId);
        return;
    }

    if (game.turnIndex >= game.players.length) {
        game.turnIndex = 0; // loop
    }

    const current = game.players[game.turnIndex];
    game.currentPlayer = current;
    game.currentTarget = null;
    game.currentQuestion = null;
    game.currentType = null;
    game.votes = { yes: 0, no: 0, voters: new Set() };
    game.state = 'wait_target';

    // Possible targets = everyone except current player
    const targets = game.players.filter(p => p !== current);
    const targetList = targets.map(p => tag(p)).join('  ');

    const txt = [
        `*🎯 ${tag(current)}, it's your turn!*`,
        '',
        'Pick someone to challenge:',
        targetList,
        '',
        '> Tag them or type their number. ⏳ 20s',
    ].join('\n');

    await sendCard(sock, chatId, txt, 'choice', [current, ...targets], null, '🎯 Pick a Target', 'Challenge someone!');

    game.timer = setTimeout(async () => {
        const g = games.get(chatId);
        if (g && g.state === 'wait_target' && jidMatch(g.currentPlayer, current)) {
            await sock.sendMessage(chatId, {
                text: `⏳ Time's up! ${tag(current)} didn't pick a target.\n> ❌ *Eliminated!*`,
                mentions: [current]
            });
            eliminatePlayer(sock, chatId, current);
        }
    }, TARGET_MS);
}

async function handleTargetPick(sock, chatId, senderId, message) {
    const game = games.get(chatId);
    if (!game || game.state !== 'wait_target' || !jidMatch(game.currentPlayer, senderId)) return;

    // Try to find mentioned JID
    const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    let target = null;
    
    // 1. Check mentioned JIDs
    for (const mJid of mentioned) {
        const found = findInPlayers(game.players, mJid);
        if (found && !jidMatch(found, senderId)) {
            target = found;
            break;
        }
    }

    // 2. Fallback: match by number or partial ID in text
    if (!target) {
        const text = (message.message?.conversation || message.message?.extendedTextMessage?.text || '').trim().toLowerCase();
        target = game.players.find(p => {
            const norm = normalizeJid(p);
            return !jidMatch(p, senderId) && (text.includes(norm) || (text.includes('@') && text.includes(norm.slice(0, 5))));
        });
    }

    if (!target) {
        await sock.sendMessage(chatId, {
            text: `❓ ${tag(senderId)} — tag a valid player from the game!`,
            mentions: [senderId]
        });
        return;
    }

    clearTimeout(game.timer);
    game.currentTarget = target;
    game.state = 'wait_choice';

    const txt = [
        `*❔ ${tag(target)} — ${tag(senderId)} challenges you!*`,
        '',
        'Choose your fate:',
        '• *truth*',
        '• *dare*',
        '',
        '> Reply with truth or dare. ⏳ 20s',
    ].join('\n');

    await sendCard(sock, chatId, txt, 'choice', [target, senderId], null, '⚡ Truth or Dare?', 'Choose your fate');

    game.timer = setTimeout(async () => {
        const g = games.get(chatId);
        if (g && g.state === 'wait_choice' && jidMatch(g.currentTarget, target)) {
            await sock.sendMessage(chatId, {
                text: `⏳ Time's up! ${tag(target)} didn't choose.\n> ❌ *Eliminated!*`,
                mentions: [target]
            });
            eliminatePlayer(sock, chatId, target);
        }
    }, CHOICE_MS);
}

async function handleChoice(sock, chatId, senderId, choice) {
    const game = games.get(chatId);
    if (!game || game.state !== 'wait_choice' || !jidMatch(game.currentTarget, senderId)) return;

    const type = choice.toLowerCase().trim();
    if (type !== 'truth' && type !== 'dare') return;

    clearTimeout(game.timer);
    game.currentType = type;

    const usedSet = type === 'truth' ? game.usedTruths : game.usedDares;
    const question = await generateQuestion(type, tag(senderId), usedSet, game.round || 1);
    game.currentQuestion = question;
    game.stateChangedAt = Date.now();

    if (type === 'truth') {
        game.state = 'wait_truth_answer';
        game.stateChangedAt = Date.now();
        saveGames();
        const txt = [
            `🧠 *Truth for ${tag(senderId)}:*`,
            '',
            `${question}`,
            '',
            '> Answer honestly. ⏳ 45s',
            '> Type *no* / *skip* to refuse (you\'ll be eliminated)',
        ].join('\n');
        await sendCard(sock, chatId, txt, 'truth', [senderId], null, '🧠 Truth Time', 'Answer honestly...');

        game.timer = setTimeout(async () => {
            const g = games.get(chatId);
            if (g && g.state === 'wait_truth_answer' && jidMatch(g.currentTarget, senderId)) {
                await sock.sendMessage(chatId, {
                    text: `⏳ ${tag(senderId)} didn't answer the truth in time.\n> ❌ *Eliminated!*`,
                    mentions: [senderId]
                });
                eliminatePlayer(sock, chatId, senderId);
            }
        }, ANSWER_MS);

    } else {
        game.state = 'wait_dare_proof';
        game.stateChangedAt = Date.now();
        saveGames();
        const txt = [
            `⚡ *Dare for ${tag(senderId)}:*`,
            '',
            `${question}`,
            '',
            '> 📸 Send *proof* (image, video, or voice note). ⏳ 30s',
            '> Type *no* / *skip* to refuse (you\'ll be eliminated)',
        ].join('\n');
        await sendCard(sock, chatId, txt, 'dare', [senderId], null, '⚡ Dare Time', 'Complete it or get eliminated');

        game.timer = setTimeout(async () => {
            const g = games.get(chatId);
            if (g && g.state === 'wait_dare_proof' && jidMatch(g.currentTarget, senderId)) {
                await sock.sendMessage(chatId, {
                    text: `⏳ ${tag(senderId)} didn't complete the dare in time.\n> ❌ *Eliminated!*`,
                    mentions: [senderId]
                });
                eliminatePlayer(sock, chatId, senderId);
            }
        }, PROOF_MS);
    }
}

async function handleTruthAnswer(sock, chatId, senderId, message) {
    const game = games.get(chatId);
    if (!game || game.state !== 'wait_truth_answer' || !jidMatch(game.currentTarget, senderId)) return;

    const text = (message.message?.conversation || message.message?.extendedTextMessage?.text || '').trim();
    if (!text) return;

    if (isSkipping(text)) {
        clearTimeout(game.timer);
        await sock.sendMessage(chatId, {
            text: `🚫 ${tag(senderId)} refused to answer the truth.\n> ❌ *Eliminated!*`,
            mentions: [senderId]
        });
        eliminatePlayer(sock, chatId, senderId);
        return;
    }

    clearTimeout(game.timer);
    game.state = 'voting';

    const voteText = [
        `📊 *Do you think ${tag(senderId)} is telling the truth?*`,
        '',
        `_"${text}"_`,
        '',
        '👍 = Believe  |  👎 = Cap',
        '',
        '> Voting time: 10s',
    ].join('\n');

    await sock.sendMessage(chatId, { text: voteText, mentions: [senderId] });

    game.timer = setTimeout(() => resolveTruthVote(sock, chatId), VOTE_MS);
}

async function resolveTruthVote(sock, chatId) {
    const game = games.get(chatId);
    if (!game) return;

    if (game.votes.no > game.votes.yes) {
        await sock.sendMessage(chatId, {
            text: `🚫 *Majority says it's a lie!*\n> ${tag(game.currentTarget)} is now forced into a dare.\n> ❌ Or get eliminated.`,
            mentions: [game.currentTarget]
        });
        // Force dare
        const dare = await generateQuestion('dare', tag(game.currentTarget), game.usedDares);
        game.currentQuestion = dare;
        game.currentType = 'dare';
        game.state = 'wait_dare_proof';
        await sendCard(sock, chatId, `⚡ *Forced Dare for ${tag(game.currentTarget)}:*\n\n> _${dare}_\n\n> 📸 Send proof. ⏳ 30s\n> Type *no* to get eliminated.`, 'dare', [game.currentTarget], null, '⚡ Forced Dare', 'Complete it now!');
        game.timer = setTimeout(async () => {
            const g = games.get(chatId);
            if (g && g.state === 'wait_dare_proof' && g.currentTarget === game.currentTarget) {
                await sock.sendMessage(chatId, { text: `⏳ Time's up! ${tag(game.currentTarget)} is ❌ *eliminated*.`, mentions: [game.currentTarget] });
                eliminatePlayer(sock, chatId, game.currentTarget);
            }
        }, PROOF_MS);
    } else {
        await sock.sendMessage(chatId, {
            text: `✅ *Accepted!*\n> ${tag(game.currentTarget)} passes this round.`,
            mentions: [game.currentTarget]
        });
        finishTurn(sock, chatId);
    }
}

async function handleDareProof(sock, chatId, senderId, message) {
    const game = games.get(chatId);
    if (!game || game.state !== 'wait_dare_proof' || !jidMatch(game.currentTarget, senderId)) return;

    const text = (message.message?.conversation || message.message?.extendedTextMessage?.text || '').trim().toLowerCase();

    // Text refusal
    if (text && isSkipping(text)) {
        clearTimeout(game.timer);
        await sock.sendMessage(chatId, {
            text: `🚫 ${tag(senderId)} refused the dare.\n> ❌ *Eliminated!*`,
            mentions: [senderId]
        });
        eliminatePlayer(sock, chatId, senderId);
        return;
    }

    const hasImage = message.message?.imageMessage;
    const hasVideo = message.message?.videoMessage;
    const hasAudio = message.message?.audioMessage;

    if (!hasImage && !hasVideo && !hasAudio) return; // not a proof message

    clearTimeout(game.timer);

    // If voice note, transcribe it for verification
    if (hasAudio) {
        await sock.sendMessage(chatId, { text: '🎙️ Checking voice note...', mentions: [senderId] });
        const transcript = await transcribeAudio(hasAudio);
        if (transcript) {
            await sock.sendMessage(chatId, {
                text: `🎙️ *Voice note says:*\n_"${transcript}"_\n\n> ${tag(senderId)} completed the dare! ✅`,
                mentions: [senderId]
            });
        } else {
            await sock.sendMessage(chatId, {
                text: `✅ ${tag(senderId)} completed the dare! Clean.`,
                mentions: [senderId]
            });
        }
    } else {
        await sock.sendMessage(chatId, {
            text: `✅ ${tag(senderId)} completed the dare! Proof received.`,
            mentions: [senderId]
        });
    }

    finishTurn(sock, chatId);
}

async function handleTodReaction(sock, reaction) {
    const chatId = reaction?.key?.remoteJid;
    if (!chatId) return;
    const game = games.get(chatId);
    if (!game || game.state !== 'voting') return;

    const voterId = reaction.key?.participant || reaction.key?.remoteJid;
    if (!findInPlayers(game.players, voterId)) return;
    if (game.votes.voters.has(voterId)) return;
    game.votes.voters.add(voterId);

    const emoji = reaction.text;
    if (emoji === '👍') game.votes.yes++;
    else if (emoji === '👎') game.votes.no++;
}

// ─── Elimination ──────────────────────────────────────────────────────────────
async function eliminatePlayer(sock, chatId, playerJid) {
    const game = games.get(chatId);
    if (!game) return;

    clearTimeout(game.timer);
    game.players = game.players.filter(p => !jidMatch(p, playerJid));
    game.votes = { yes: 0, no: 0, voters: new Set() };

    // Adjust turn index so we don't skip anyone
    const eliminatedIndex = game.turnIndex;
    if (game.players.length === 0) {
        await sendCard(sock, chatId, '🏁 *Game over — everyone was eliminated!*', 'win', [], null, '🏁 Game Over', 'Everyone was eliminated!');
        endGame(chatId);
        return;
    }

    if (game.players.length === 1) {
        const winner = game.players[0];
        await sendCard(sock, chatId, `🏆 *${tag(winner)} wins Truth or Dare!*\n\n> Last one standing 👑`, 'win', [winner], null, '🏆 Winner!', `${tag(winner)} survives!`);
        endGame(chatId);
        return;
    }

    // Keep turn index in range
    if (game.turnIndex >= game.players.length) game.turnIndex = 0;

    await sleep(1500);
    if (!games.has(chatId)) return;
    nextTurn(sock, chatId);
}

// ─── Turn end ─────────────────────────────────────────────────────────────────
async function finishTurn(sock, chatId) {
    const game = games.get(chatId);
    if (!game) return;
    clearTimeout(game.timer);
    
    const prevIndex = game.turnIndex;
    game.turnIndex = (game.turnIndex + 1) % game.players.length;
    
    // If we looped back to the first player, increment round
    if (game.turnIndex === 0 && prevIndex !== 0) {
        game.round = (game.round || 1) + 1;
    }
    
    game.votes = { yes: 0, no: 0, voters: new Set() };
    await sleep(1500);
    if (!games.has(chatId)) return;
    nextTurn(sock, chatId);
}

// ─── Public helpers ───────────────────────────────────────────────────────────
function isParticipant(chatId, senderId) {
    const game = games.get(chatId);
    return !!(game && findInPlayers(game.players, senderId));
}

// ─── Main message router (called from main.js) ────────────────────────────────
async function handleTodMessage(sock, chatId, senderId, message) {
    const game = games.get(chatId);
    if (!game) return;

    const text = (message.message?.conversation || message.message?.extendedTextMessage?.text || '').trim();
    const lower = text.toLowerCase().trim();

    // Kill stale games immediately if interacted with
    const lastActive = game.stateChangedAt || game.createdAt || Date.now();
    if (Date.now() - lastActive > MAX_INACTIVITY_MS) {
        console.log(`[TOD] Discarding stale game in ${chatId} on interaction`);
        endGame(chatId);
        saveGames();
        return;
    }

    // Command to stop the game or leave
    if (lower === '.tod stop' || lower === '.tod end' || lower === '.tod quit' || lower === '.tod leave') {
        const adminStatus = await sock.groupMetadata(chatId).then(m => m.participants.find(p => jidMatch(p.id, senderId))).catch(() => null);
        const isHost = jidMatch(game.hostId, senderId);
        const isAdmin = adminStatus?.admin === 'admin' || adminStatus?.admin === 'superadmin';

        if (lower === '.tod leave' || (lower === '.tod quit' && !isHost && !isAdmin)) {
            if (isParticipant(chatId, senderId)) {
                game.players = game.players.filter(p => !jidMatch(p, senderId));
                await sock.sendMessage(chatId, { text: `👋 ${tag(senderId)} left the game.` });
                if (game.players.length < 2 && game.started) {
                    clearTimeout(game.timer);
                    endGame(chatId);
                    saveGames();
                    await sock.sendMessage(chatId, { text: '🏁 *Game ended — not enough players left.*' });
                } else if (jidMatch(game.currentPlayer, senderId) || jidMatch(game.currentTarget, senderId)) {
                    clearTimeout(game.timer);
                    nextTurn(sock, chatId);
                }
                return true;
            }
        }

        if (isHost || isAdmin) {
            clearTimeout(game.timer);
            endGame(chatId);
            saveGames();
            await sock.sendMessage(chatId, { text: `🏁 *Game ended by ${isHost ? 'host' : 'admin'}.*` });
            return true;
        }
    }

    // Early start command for host
    if (lower === '.start' && !game.started && game.lobbyOpen) {
        if (!jidMatch(game.players[0], senderId)) {
            await sock.sendMessage(chatId, { text: '❌ Only the game host can use .start' }, { quoted: message });
            return true; // handled
        }
        if (game.players.length < 2) {
            await sock.sendMessage(chatId, { text: '❌ Need at least 2 players to start.' }, { quoted: message });
            return true; // handled
        }
        clearTimeout(game.timer); // Cancel lobby timeout
        await lockAndRun(sock, chatId);
        return true; // handled
    }

    if (!game.started) return;

    switch (game.state) {
        case 'wait_target':
            if (jidMatch(game.currentPlayer, senderId)) {
                await handleTargetPick(sock, chatId, senderId, message);
            }
            break;

        case 'wait_choice':
            if (jidMatch(game.currentTarget, senderId)) {
                if (lower === 'truth' || lower === 'dare') {
                    await handleChoice(sock, chatId, senderId, lower);
                }
            }
            break;

        case 'wait_truth_answer':
            if (jidMatch(game.currentTarget, senderId) && text) {
                await handleTruthAnswer(sock, chatId, senderId, message);
            }
            break;

        case 'wait_dare_proof':
            if (jidMatch(game.currentTarget, senderId)) {
                // Check text refusal first
                if (text && isSkipping(lower)) {
                    await handleDareProof(sock, chatId, senderId, message);
                    return;
                }
                // Check media proof
                const hasMedia = message.message?.imageMessage || message.message?.videoMessage || message.message?.audioMessage;
                if (hasMedia) {
                    await handleDareProof(sock, chatId, senderId, message);
                }
            }
            break;
    }
}

module.exports = {
    startTruthOrDare,
    joinTruthOrDare,
    isParticipant,
    handleTodMessage,
    handleReaction: handleTodReaction,
    restoreGameTimers,
    startStaleCleanup,
};

// Load any games that were in progress when bot last shut down
loadSavedGames();
