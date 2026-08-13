const fs = require('fs');
const path = require('path');
const https = require('https');

const THUMB_URL = 'https://i.ibb.co/mr0gcYMs/e406f44b-696f-4a70-bcf4-c0aa27ba89a0-removalai-preview.png';
const DATA_PATH = path.join(process.cwd(), 'data', 'antismSettings.json');
let thumbCache = null;

function buildWarnText(userNumber, actionText, currentWarns, maxWarns) {
    const dots = Array.from({ length: maxWarns }, (_, i) => (i < currentWarns ? '●' : '○')).join('');
    const remaining = Math.max(0, maxWarns - currentWarns);
    return [
        '*╭⚠ WISTORIA SECURITY╮*',
        `│ @${userNumber}`,
        `│ × ${actionText}`,
        `│ warn: ${dots}`,
        `│ ${remaining}/${maxWarns} left`,
        '╰──────────────'
    ].join('\n');
}

function ensureStore() {
    const dir = path.dirname(DATA_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(DATA_PATH)) {
        fs.writeFileSync(DATA_PATH, JSON.stringify({ groups: {}, warnings: {} }, null, 2), 'utf8');
    }
}

function loadStore() {
    ensureStore();
    try {
        const raw = fs.readFileSync(DATA_PATH, 'utf8');
        const data = JSON.parse(raw || '{}');
        return {
            groups: data.groups || {},
            warnings: data.warnings || {}
        };
    } catch {
        return { groups: {}, warnings: {} };
    }
}

function saveStore(data) {
    ensureStore();
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function setConfig(groupId, enabled, maxWarns = 5) {
    const store = loadStore();
    store.groups[groupId] = {
        enabled: Boolean(enabled),
        maxWarns: Math.max(1, Math.min(10, Number(maxWarns || 5)))
    };
    saveStore(store);
    return store.groups[groupId];
}

function getConfig(groupId) {
    const store = loadStore();
    return store.groups[groupId] || null;
}

function removeConfig(groupId) {
    const store = loadStore();
    delete store.groups[groupId];
    delete store.warnings[groupId];
    saveStore(store);
}

function addWarning(groupId, userId) {
    const store = loadStore();
    if (!store.warnings[groupId]) store.warnings[groupId] = {};
    store.warnings[groupId][userId] = Number(store.warnings[groupId][userId] || 0) + 1;
    saveStore(store);
    return store.warnings[groupId][userId];
}

function resetWarning(groupId, userId) {
    const store = loadStore();
    if (store.warnings[groupId]) {
        delete store.warnings[groupId][userId];
        saveStore(store);
    }
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

function getWarnDots(count, maxWarns) {
    return Array.from({ length: maxWarns }, (_, i) => (i < count ? '●' : '○')).join(' ');
}

function getContextInfo(message = {}) {
    return (
        message.message?.extendedTextMessage?.contextInfo ||
        message.message?.imageMessage?.contextInfo ||
        message.message?.videoMessage?.contextInfo ||
        message.message?.documentMessage?.contextInfo ||
        message.message?.audioMessage?.contextInfo ||
        message.message?.groupMentionedMessage?.message?.extendedTextMessage?.contextInfo ||
        message.message?.groupMentionedMessage?.message?.imageMessage?.contextInfo ||
        message.message?.groupMentionedMessage?.message?.videoMessage?.contextInfo ||
        {}
    );
}

function extractText(message = {}) {
    return (
        message.message?.groupMentionedMessage?.message?.conversation ||
        message.message?.groupMentionedMessage?.message?.extendedTextMessage?.text ||
        message.message?.groupMentionedMessage?.message?.imageMessage?.caption ||
        message.message?.groupMentionedMessage?.message?.videoMessage?.caption ||
        message.message?.conversation ||
        message.message?.extendedTextMessage?.text ||
        message.message?.imageMessage?.caption ||
        message.message?.videoMessage?.caption ||
        message.message?.documentMessage?.caption ||
        ''
    );
}

function containsStatusBroadcast(value, seen = new WeakSet()) {
    if (typeof value === 'string') {
        return value.toLowerCase().includes('status@broadcast');
    }
    if (!value || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);

    if (Array.isArray(value)) {
        return value.some((entry) => containsStatusBroadcast(entry, seen));
    }

    return Object.values(value).some((entry) => containsStatusBroadcast(entry, seen));
}

function hasStatusMention(message = {}) {
    if (String(message?.message?.reactionMessage?.key?.remoteJid || '').toLowerCase() === 'status@broadcast') {
        return true;
    }

    if (String(message?.key?.remoteJid || '').toLowerCase() === 'status@broadcast') {
        return true;
    }

    if (containsStatusBroadcast(message?.message)) {
        return true;
    }

    if (message?.message?.groupMentionedMessage) {
        return true;
    }

    const ctx = getContextInfo(message);
    const mentioned = Array.isArray(ctx.mentionedJid) ? ctx.mentionedJid : [];
    if (mentioned.some((jid) => String(jid).toLowerCase() === 'status@broadcast')) {
        return true;
    }

    const groupMentions = Array.isArray(ctx.groupMentions) ? ctx.groupMentions : [];
    if (groupMentions.length > 0) {
        return true;
    }

    const text = extractText(message);
    return /(^|\s)@status\b/i.test(text) || /\bstatus@broadcast\b/i.test(text);
}

function isPermissionStyleError(error) {
    const text = String(error?.message || error || '').toLowerCase();
    return text.includes('not-authorized') || text.includes('forbidden') || text.includes('not admin');
}

function adReply(thumb, title, body) {
    return {
        externalAdReply: {
            title,
            body,
            sourceUrl: '',
            mediaType: 1,
            renderLargerThumbnail: false,
            showAdAttribution: false,
            ...(thumb ? { thumbnail: thumb } : {})
        }
    };
}

async function handleAntismCommand(sock, chatId, userMessage, senderId, isSenderAdmin, message) {
    try {
        if (!isSenderAdmin) {
            await sock.sendMessage(chatId, {
                text: '┌─〔 *WISTORIA SECURITY* 〕─┐\n│\n│  admins only.\n│\n└──────────────'
            }, { quoted: message });
            return;
        }

        const normalizedInput = String(userMessage || '').trim().toLowerCase();
        const parts = normalizedInput.split(/\s+/);
        const action = String(parts[1] || '').toLowerCase();
        const isSimpleAlias = normalizedInput.startsWith('.antistatus ');

        if (!action) {
            await sock.sendMessage(chatId, {
                text: [
                    '┌─〔 *WISTORIA SECURITY* 〕─┐',
                    '│',
                    '│  .antism on',
                    '│  .antism off',
                    '│  .antism get',
                    '│  .antism setwarn 5',
                    '│',
                    '└──────────────'
                ].join('\n')
            }, { quoted: message });
            return;
        }

        if (action === 'on') {
            const existing = getConfig(chatId);
            if (existing?.enabled) {
                await sock.sendMessage(chatId, {
                    text: isSimpleAlias
                        ? '🛡️ Anti-Status-Mention is already enabled'
                        : 'status mention protection is already *on*.'
                }, { quoted: message });
                return;
            }
            setConfig(chatId, true, existing?.maxWarns || 5);
            await sock.sendMessage(chatId, {
                text: isSimpleAlias
                    ? '🛡️ Anti-Status-Mention ENABLED'
                    : 'status mention protection turned *on*.\ndefault warns: *5*'
            }, { quoted: message });
            return;
        }

        if (action === 'off') {
            removeConfig(chatId);
            await sock.sendMessage(chatId, {
                text: isSimpleAlias
                    ? '❌ Anti-Status-Mention DISABLED'
                    : 'status mention protection turned *off*.'
            }, { quoted: message });
            return;
        }

        if (action === 'get') {
            const config = getConfig(chatId);
            await sock.sendMessage(chatId, {
                text: [
                    '┌─〔 *WISTORIA SECURITY* 〕─┐',
                    '│',
                    `│  status : *${config?.enabled ? 'on' : 'off'}*`,
                    `│  warns  : *${config?.maxWarns || 5}*`,
                    '│',
                    '└──────────────'
                ].join('\n')
            }, { quoted: message });
            return;
        }

        if (action === 'setwarn') {
            const rawWarns = Number(parts[2]);
            if (!Number.isFinite(rawWarns)) {
                await sock.sendMessage(chatId, { text: 'use `.antism setwarn 5`' }, { quoted: message });
                return;
            }
            const existing = getConfig(chatId);
            const maxWarns = Math.max(1, Math.min(10, rawWarns));
            setConfig(chatId, existing?.enabled ?? true, maxWarns);
            await sock.sendMessage(chatId, { text: `status mention warns set to *${maxWarns}*.` }, { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, { text: 'unknown action. use `.antism` for help.' }, { quoted: message });
    } catch (error) {
        console.error('[antism] command error:', error);
        await sock.sendMessage(chatId, { text: 'failed to update antism.' }, { quoted: message });
    }
}

async function handleStatusMentionDetection(sock, chatId, message, senderId) {
    try {
        const config = getConfig(chatId);
        if (!config?.enabled) return;
        if (!hasStatusMention(message)) return;

        try {
            await sock.sendMessage(chatId, { delete: message.key });
        } catch (e) {
            console.error('[antism] delete failed:', e.message);
            try {
                await sock.sendMessage(chatId, {
                    delete: {
                        remoteJid: chatId,
                        fromMe: false,
                        id: message.key.id,
                        participant: message.key.participant || senderId
                    }
                });
            } catch (fallbackError) {
                console.error('[antism] delete fallback failed:', fallbackError.message);
            }
        }

        const currentWarns = addWarning(chatId, senderId);
        const maxWarns = Math.max(1, Math.min(10, Number(config.maxWarns || 5)));
        const warnsLeft = Math.max(0, maxWarns - currentWarns);
        const dots = getWarnDots(Math.min(currentWarns, maxWarns), maxWarns);
        const thumb = await getThumb().catch(() => null);
        const userNumber = senderId.split('@')[0];

        if (currentWarns >= maxWarns) {
            resetWarning(chatId, senderId);
            try {
                await sock.groupParticipantsUpdate(chatId, [senderId], 'remove');
            } catch (e) {
                if (isPermissionStyleError(e)) {
                    console.warn('[antism] kick skipped:', e.message); // FIXED: avoid noisy permission error spam
                } else {
                    console.error('[antism] kick failed:', e.message);
                }
            }

            await sock.sendMessage(chatId, {
                text: [
                    '┌─〔 *WISTORIA SECURITY* 〕─┐',
                    '│',
                    `│  user    : @${userNumber}`,
                    '│  action  : removed',
                    '│',
                    `│  warn    : ${getWarnDots(maxWarns, maxWarns)}`,
                    '│',
                    '│  reason  : status mention',
                    '│  note    : removed after max warns',
                    '│',
                    '└──────────────'
                ].join('\n'),
                mentions: [senderId],
                contextInfo: adReply(thumb, 'WISTORIA SECURITY', `status mention removed after ${maxWarns} warns`)
            });
            return;
        }

        await sock.sendMessage(chatId, {
            text: buildWarnText(userNumber, 'mention removed', currentWarns, maxWarns),
            mentions: [senderId],
            contextInfo: adReply(thumb, 'WISTORIA SECURITY', `warning ${currentWarns}/${maxWarns}`)
        });
        return;

        await sock.sendMessage(chatId, {
            text: [
                '┌─〔 *WISTORIA SECURITY* 〕─┐',
                '│',
                `│  user    : @${userNumber}`,
                '│  action  : status mention removed',
                '│',
                `│  warn    : ${dots}`,
                '│',
                `│  next    : ${warnsLeft === 1 ? '1 warn left' : `${warnsLeft} warns left`}`,
                `│  limit   : ${maxWarns}`,
                '│',
                '└──────────────'
            ].join('\n'),
            mentions: [senderId],
            contextInfo: adReply(thumb, 'WISTORIA SECURITY', `warning ${currentWarns}/${maxWarns}`)
        });
    } catch (error) {
        console.error('[antism] detection error:', error);
    }
}

module.exports = {
    handleAntismCommand,
    handleStatusMentionDetection
};
