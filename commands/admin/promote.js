const isAdmin = require('../../lib/isAdmin');
const https = require('https');
const { markAdminUpdate } = require('../../lib/adminUpdateTracker');
const isOwnerOrSudo = require('../../lib/isOwner');
const { hasStaffRole } = require('../../lib/staffRoles');

const THUMB_URL = 'https://files.catbox.moe/pn8q35.png';
let thumbCache = null;

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

function normalizeJid(value) {
    if (typeof value === 'object' && value) {
        value = value.id || value.jid || value.participant || value.remoteJid || value;
    }
    const val = String(value || '').trim();
    if (!val || val === '[object Object]') return '';
    const base = val.split('@')[0].split(':')[0];
    const domain = val.includes('@') ? val.split('@')[1] : 's.whatsapp.net';
    return `${base}@${domain}`;
}

function sameUser(a, b) {
    const left = normalizeJid(a).split('@')[0];
    const right = normalizeJid(b).split('@')[0];
    return Boolean(left && right && left === right);
}

function toTag(jid) {
    return `@${String(jid).split('@')[0].split(':')[0]}`;
}

function buildCard(lines, thumb, mentions = []) {
    return {
        text:
            'PROMOTE\n\n' +
            lines.join('\n'),
        mentions,
        contextInfo: {
            externalAdReply: {
                title: 'PROMOTED',
                body: 'Group management',
                mediaUrl: '',
                sourceUrl: '',
                mediaType: 1,
                renderLargerThumbnail: false,
                showAdAttribution: false,
                ...(thumb ? { thumbnail: thumb } : {})
            }
        }
    };
}

function participantIds(participant) {
    return [
        participant?.id,
        participant?.jid,
        participant?.participantAlt,
        participant?.lid ? `${String(participant.lid).split('@')[0]}@lid` : '',
        participant?.pn ? `${String(participant.pn).split('@')[0]}@s.whatsapp.net` : '',
        participant?.phoneNumber ? `${String(participant.phoneNumber).split('@')[0]}@s.whatsapp.net` : ''
    ].filter(Boolean).map(normalizeJid);
}

async function resolveTargets(sock, chatId, message, mentionedJids = []) {
    const metadata = await sock.groupMetadata(chatId);
    const requested = [];

    if (Array.isArray(mentionedJids) && mentionedJids.length) {
        requested.push(...mentionedJids);
    }

    const quoted = message.message?.extendedTextMessage?.contextInfo?.participant;
    if (quoted) requested.push(quoted);

    const uniqueRequested = [...new Set(requested.map(normalizeJid).filter(Boolean))];
    if (!uniqueRequested.length) return [];

    const resolved = uniqueRequested.map((target) => {
        const match = (metadata.participants || []).find((participant) =>
            participantIds(participant).some((candidate) => sameUser(candidate, target))
        );
        return match ? participantIds(match)[0] : target;
    });

    return [...new Set(resolved.filter(Boolean))];
}

async function promoteCommand(sock, chatId, mentionedJids, message, options = {}) {
    try {
        if (!chatId.endsWith('@g.us')) {
            await sock.sendMessage(chatId, { text: 'Groups only.' }, { quoted: message });
            return;
        }

        const senderJid = normalizeJid(message.key.participant || message.key.remoteJid);
        const senderHasBypass = Boolean(
            options.allowModBypass ||
            message?.key?.fromMe ||
            hasStaffRole(senderJid, ['mods']) ||
            await isOwnerOrSudo(senderJid).catch(() => false)
        );
        const adminStatus = await isAdmin(sock, chatId, message.key.participant || message.key.remoteJid);

        if (!adminStatus.isBotAdmin) {
            await sock.sendMessage(chatId, { text: 'Bot is not admin. Make me admin first.' }, { quoted: message });
            return;
        }

        if (!adminStatus.isSenderAdmin && !senderHasBypass) {
            await sock.sendMessage(chatId, { text: 'Only group admins can use `.promote`.' }, { quoted: message });
            return;
        }

        let targets = await resolveTargets(sock, chatId, message, mentionedJids);
        if (options.selfPromoteOnly || (!targets.length && senderHasBypass)) {
            targets = [senderJid].filter(Boolean);
        }
        if (!targets.length) {
            await sock.sendMessage(chatId, { text: 'Mention or reply to a user to promote.' }, { quoted: message });
            return;
        }

        markAdminUpdate(chatId, 'promote', targets);
        await sock.groupParticipantsUpdate(chatId, targets, 'promote');

        const thumb = await getThumb();

        await sock.sendMessage(chatId, buildCard([
            `User: ${targets.map(toTag).join(', ')}`,
            'Role: Group admin',
            `By: ${toTag(senderJid)}`,
            'Status: promoted'
        ], thumb, [...targets, senderJid].filter(Boolean)));
    } catch (error) {
        console.error('Error in promote command:', error);
        await sock.sendMessage(chatId, { text: 'Failed to promote user.' }, { quoted: message });
    }
}

async function handlePromotionEvent(sock, groupId, participants, author) {
    try {
        if (!groupId || !participants) return;

        const targets = (participants || []).map(normalizeJid).filter(Boolean);
        if (!targets.length) return;

        const byJid = normalizeJid(author);
        const thumb = await getThumb();

        await sock.sendMessage(groupId, buildCard([
            `User: ${targets.map(toTag).join(', ')}`,
            'Role: Group admin',
            `By: ${byJid ? toTag(byJid) : 'system'}`,
            'Status: promoted'
        ], thumb, [...targets, byJid].filter(Boolean)));
    } catch (error) {
        console.error('Error handling promotion event:', error);
    }
}

module.exports = { promoteCommand, handlePromotionEvent };
