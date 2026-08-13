const fs = require('fs').promises;
const path = require('path');
const { buildOfficialLinkPreview } = require('./linkPreviewHelper');

const STORE_PATH = path.join(process.cwd(), 'data', 'gambling-access.json');
const GAMBLING_GROUP_LINK = 'https://chat.whatsapp.com/CRjAFtC7xCg9l3CKtxfUbf';
const GAMBLING_COMMANDS = new Set([
    '.coinflip', '.cf',
    '.dice', '.roll',
    '.dicepoker', '.dp',
    '.highlow', '.market',
    '.wheel',
    '.roulette', '.rlt',
    '.slots', '.slot',
    '.jackpot', '.jp',
    '.bet',
    '.raffle',
    '.blackjack', '.bj'
]);

async function ensureStore() {
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    try {
        const parsed = JSON.parse(await fs.readFile(STORE_PATH, 'utf8'));
        if (!Array.isArray(parsed.enabledGroups)) {
            throw new Error('Invalid gambling access store');
        }
        return parsed;
    } catch (error) {
        if (error.code && error.code !== 'ENOENT') {
            console.error('[gamblingAccess] Failed to read store:', error);
        }
        const initial = { enabledGroups: [] };
        await fs.writeFile(STORE_PATH, JSON.stringify(initial, null, 2), 'utf8'); // FIXED: gambling access store auto-init
        return initial;
    }
}

async function saveStore(data) {
    await fs.writeFile(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function normalizeGroupId(chatId) {
    return typeof chatId === 'string' && chatId.endsWith('@g.us') ? chatId : '';
}

function isGamblingCommand(commandKey) {
    return GAMBLING_COMMANDS.has(String(commandKey || '').toLowerCase());
}

async function isGamblingEnabled(chatId) {
    const groupId = normalizeGroupId(chatId);
    if (!groupId) return false;
    const data = await ensureStore();
    return data.enabledGroups.includes(groupId); // FIXED: group-scoped gambling toggle
}

async function setGamblingEnabled(chatId, enabled) {
    const groupId = normalizeGroupId(chatId);
    if (!groupId) return false;
    const data = await ensureStore();
    data.enabledGroups = data.enabledGroups.filter((id) => id !== groupId);
    if (enabled) {
        data.enabledGroups.push(groupId);
    }
    await saveStore(data); // FIXED: persistent gambling group toggle
    return true;
}

async function buildGamblingLockedPayload(sock) {
    const text = [
        '*Gambling is disabled here.*',
        '',
        'Join the gambling group to use slots, jackpot, roulette, dice, coinflip, wheel, raffle, and bet commands.',
        '',
        GAMBLING_GROUP_LINK
    ].join('\n');

    try {
        const linkPreview = await buildOfficialLinkPreview(sock, GAMBLING_GROUP_LINK, {
            title: 'Gambling Group',
            description: 'WhatsApp Group Invite'
        });
        return { text, linkPreview }; // FIXED: official gambling invite preview payload
    } catch (error) {
        console.error('[gamblingAccess] preview build failed:', error?.message || error);
        return { text };
    }
}

async function sendGamblingLockedMessage(sock, chatId, message) {
    const payload = await buildGamblingLockedPayload(sock);
    await sock.sendMessage(chatId, payload, message ? { quoted: message } : {}); // FIXED: blocked gambling group invite reply
}

module.exports = {
    GAMBLING_GROUP_LINK,
    isGamblingCommand,
    isGamblingEnabled,
    setGamblingEnabled,
    sendGamblingLockedMessage
};
