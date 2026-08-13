const fs = require('fs');
const path = require('path');
const https = require('https');
const { getBalance, addBalance, progressMission } = require('../../lib/economy');

const STATE_PATH = path.join(__dirname, '../data/elementwar.json');
const COOLDOWN_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 2 * 60 * 1000;
const REVEAL_DELAY_MS = 4000;
const DRAW_REWARD = 10;
const ACTIVE_THUMB_URL = 'https://files.catbox.moe/gc9w1c.png';
const LOSS_THUMB_URL = 'https://i.ibb.co/DH8bMsQV/download-10.jpg';
const WIN_THUMB_URL = 'https://i.ibb.co/rGGjFy46/image.png';

const ELEMENTS = {
    '1': { slot: '1', name: 'Fire', lower: 'fire', icon: '🔥', beats: '4' },
    '2': { slot: '2', name: 'Water', lower: 'water', icon: '💧', beats: '1' },
    '3': { slot: '3', name: 'Earth', lower: 'earth', icon: '🌍', beats: '2' },
    '4': { slot: '4', name: 'Air', icon: '🌪️', lower: 'air', beats: '3' }
};

let activeThumbCache = null;
let lossThumbCache = null;
let winThumbCache = null;

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

async function getThumbBuffer(kind) {
    if (kind === 'active') {
        if (!activeThumbCache) activeThumbCache = await fetchBuffer(ACTIVE_THUMB_URL).catch(() => null);
        return activeThumbCache;
    }
    if (kind === 'win') {
        if (!winThumbCache) winThumbCache = await fetchBuffer(WIN_THUMB_URL).catch(() => null);
        return winThumbCache;
    }
    if (!lossThumbCache) lossThumbCache = await fetchBuffer(LOSS_THUMB_URL).catch(() => null);
    return lossThumbCache;
}

async function buildElementWarPayload(text, kind) {
    const title = kind === 'active' ? 'ELEMENT WAR' : (kind === 'win' ? 'ELEMENT WIN' : 'ELEMENT LOSS');
    const body = kind === 'active' ? 'energy building' : (kind === 'win' ? 'element victory' : 'element defeat');
    const thumbnail = await getThumbBuffer(kind);

    return {
        text,
        contextInfo: {
            externalAdReply: {
                title,
                body,
                mediaType: 1,
                mediaUrl: '',
                renderLargerThumbnail: false,
                showAdAttribution: false,
                sourceUrl: '',
                ...(thumbnail ? { thumbnail } : {
                    thumbnailUrl: kind === 'active' ? ACTIVE_THUMB_URL : (kind === 'win' ? WIN_THUMB_URL : LOSS_THUMB_URL)
                })
            }
        }
    };
}

function loadState() {
    if (!fs.existsSync(STATE_PATH)) {
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        fs.writeFileSync(STATE_PATH, JSON.stringify({ users: {}, pending: {} }, null, 2), 'utf8');
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        if (!parsed.users || typeof parsed.users !== 'object') parsed.users = {};
        if (!parsed.pending || typeof parsed.pending !== 'object') parsed.pending = {};
        return parsed;
    } catch {
        return { users: {}, pending: {} };
    }
}

function saveState(state) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function getUserState(state, jid) {
    if (!state.users[jid]) {
        state.users[jid] = { lastPlayedAt: 0 };
    }
    return state.users[jid];
}

function getPendingKey(chatId, senderId) {
    return `${chatId}::${senderId}`;
}

function cleanupPending(state) {
    const now = Date.now();
    for (const [key, value] of Object.entries(state.pending || {})) {
        if (!value || now - Number(value.createdAt || 0) > PENDING_TTL_MS) {
            delete state.pending[key];
        }
    }
}

function formatRemaining(ms) {
    const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0 && seconds > 0) return `${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
}

function randomReward() {
    return Math.floor(Math.random() * 491) + 10;
}

function randomEnemyElement() {
    const keys = Object.keys(ELEMENTS);
    const pick = keys[Math.floor(Math.random() * keys.length)];
    return ELEMENTS[pick];
}

function buildSelectionText() {
    return [
        '┃ 🌪️ *ꜱᴇʟᴇᴄᴛ ʏᴏᴜʀ ᴇʟᴇᴍᴇɴᴛ*',
        '┃ ┉┉┉┉┉┉┉┉┉┉',
        '┃ ① 🔥 [ Fire ]   - ʙᴜʀɴꜱ ᴀɪʀ',
        '┃ ② 💧 [ Water ]  - ᴅʀᴏᴡɴꜱ ꜰɪʀᴇ',
        '┃ ③ 🌍 [ Earth ]  - ᴀʙꜱᴏʀʙꜱ ᴡᴀᴛᴇʀ',
        '┃ ④ 🌪️ [ Air ]   - ʙʟᴏᴡꜱ ᴇᴀʀᴛʜ',
        '┃ ┉┉┉┉┉┉┉┉┉┉',
        '> ⚔️ *ᴄʜᴏᴏꜱᴇ ʏᴏᴜʀ ᴇʟᴇᴍᴇɴᴛ...*',
        '',
        '> reply with 1 / 2 / 3 / 4'
    ].join('\n');
}

function buildSlipText(element, reward) {
    return [
        '┃ 🌪️ *ᴀᴄᴛɪᴠᴇ ʙᴀᴛᴛʟᴇ ꜱʟɪᴘ*',
        '┃ ━━━━━━━',
        `┃ ✧ ᴇʟᴇᴍᴇɴᴛ: [ ${toSmallCaps(element.name)} ${element.icon} ]`,
        '┃ ✧ ᴏᴘᴘᴏɴᴇɴᴛ: [ ??? ❓ ]',
        `┃ ✧ ʀᴇᴡᴀʀᴅ: ¥${reward} 💴`,
        '┃ ━━━━━━━',
        '> ⏳ *ᴇɴᴇʀɢʏ ʙᴜɪʟᴅɪɴɢ...*'
    ].join('\n');
}

function buildClashText(player, enemy) {
    return [
        '┃ ⚔️ *ʙᴀᴛᴛʟᴇ ɪɴɪᴛɪᴀᴛᴇᴅ*',
        '┃ ━━━━━━━',
        `┃ ✧ ʏᴏᴜ: ${player.icon} ${toSmallCaps(player.name)}`,
        `┃ ✧ ᴇɴᴇᴍʏ: ${enemy.icon} ${toSmallCaps(enemy.name)}`,
        '┃ ━━━━━━━',
        '> 💥 *ᴇʟᴇᴍᴇɴᴛꜱ ᴄʟᴀꜱʜɪɴɢ...*'
    ].join('\n');
}

function buildResultText(player, enemy, outcome, reward) {
    if (outcome === 'win') {
        return [
            '┃ 🏁 *ʀᴇꜱᴜʟᴛ*',
            '┃ ━━━━━━━',
            `┃ ${player.icon} ${toSmallCaps(player.name)} > ${enemy.icon} ${toSmallCaps(enemy.name)}`,
            '┃ ✧ ꜱᴛᴀᴛᴜꜱ: ᴠɪᴄᴛᴏʀʏ 🎉',
            `┃ ✧ ᴇᴀʀɴᴇᴅ: +¥${reward} 💴`,
            '┃ ━━━━━━━'
        ].join('\n');
    }

    if (outcome === 'draw') {
        return [
            '┃ 🏁 *ʀᴇꜱᴜʟᴛ*',
            '┃ ━━━━━━━',
            `┃ ${player.icon} ${toSmallCaps(player.name)} = ${enemy.icon} ${toSmallCaps(enemy.name)}`,
            '┃ ✧ ꜱᴛᴀᴛᴜꜱ: ᴅʀᴀᴡ 🤝',
            `┃ ✧ ʀᴇᴡᴀʀᴅ: +¥${reward} 💴`,
            '┃ ━━━━━━━'
        ].join('\n');
    }

    return [
        '┃ 🏁 *ʀᴇꜱᴜʟᴛ*',
        '┃ ━━━━━━━',
        `┃ ${enemy.icon} ${toSmallCaps(enemy.name)} > ${player.icon} ${toSmallCaps(player.name)}`,
        '┃ ✧ ꜱᴛᴀᴛᴜꜱ: ᴅᴇꜰᴇᴀᴛ ❌',
        '┃ ✧ ʟᴏꜱꜱ: -¥0',
        '┃ ━━━━━━━'
    ].join('\n');
}

function decideOutcome(player, enemy) {
    if (player.slot === enemy.slot) return 'draw';
    if (player.beats === enemy.slot) return 'win';
    return 'lose';
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function toSmallCaps(text) {
    const map = {
        a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ',
        k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ', s: 'ꜱ', t: 'ᴛ',
        u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ'
    };
    return String(text || '')
        .toLowerCase()
        .split('')
        .map((char) => map[char] || char)
        .join('');
}

async function elementWarCommand(sock, chatId, message, senderId) {
    try {
        const state = loadState();
        cleanupPending(state);
        const userState = getUserState(state, senderId);
        const now = Date.now();
        const remaining = Number(userState.lastPlayedAt || 0) + COOLDOWN_MS - now;

        if (remaining > 0) {
            await sock.sendMessage(chatId, {
                text: `⏳ cooldown active\n> try again in ${formatRemaining(remaining)}`
            }, { quoted: message });
            return;
        }

        const sent = await sock.sendMessage(
            chatId,
            await buildElementWarPayload(buildSelectionText(), 'active'),
            { quoted: message }
        );

        state.pending[getPendingKey(chatId, senderId)] = {
            selectionMessageId: sent?.key?.id || '',
            createdAt: Date.now(),
            reward: randomReward()
        };
        saveState(state);
    } catch (error) {
        console.error('[elementwar] start error:', error?.message || error);
        await sock.sendMessage(chatId, {
            text: 'Element war failed to start. Try again in a moment.'
        }, { quoted: message });
    }
}

async function handleElementWarReply(sock, chatId, message, senderId, rawText) {
    const pick = String(rawText || '').trim();
    if (!['1', '2', '3', '4'].includes(pick)) return false;

    const quotedId = message.message?.extendedTextMessage?.contextInfo?.stanzaId || '';
    if (!quotedId) return false;

    const state = loadState();
    cleanupPending(state);
    const key = getPendingKey(chatId, senderId);
    const pending = state.pending[key];
    if (!pending || pending.selectionMessageId !== quotedId) {
        saveState(state);
        return false;
    }

    delete state.pending[key];
    const userState = getUserState(state, senderId);
    userState.lastPlayedAt = Date.now();
    saveState(state);

    const player = ELEMENTS[pick];
    const enemy = randomEnemyElement();
    const reward = Math.max(10, Math.floor(Number(pending.reward || randomReward())));
    const outcome = decideOutcome(player, enemy);

    await sock.sendMessage(
        chatId,
        await buildElementWarPayload(buildSlipText(player, reward), 'active'),
        { quoted: message }
    );

    await sleep(REVEAL_DELAY_MS);

    await sock.sendMessage(chatId, {
        text: buildClashText(player, enemy)
    }, { quoted: message });

    await sleep(REVEAL_DELAY_MS);

    let earned = 0;
    if (outcome === 'win') {
        earned = reward;
    } else if (outcome === 'draw') {
        earned = DRAW_REWARD;
    }

    if (earned > 0) {
        addBalance(senderId, earned, { awardXp: false });
        progressMission(senderId, 'challenge');
    }

    await sock.sendMessage(
        chatId,
        await buildElementWarPayload(
            buildResultText(player, enemy, outcome, outcome === 'draw' ? DRAW_REWARD : reward),
            outcome === 'win' ? 'win' : 'loss'
        ),
        { quoted: message }
    );

    return true;
}

module.exports = {
    elementWarCommand,
    handleElementWarReply
};
