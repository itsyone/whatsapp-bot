const isAdmin = require('../../lib/isAdmin');
const https = require('https');
const { getGuardConfig } = require('../../lib/adminGuard');
const isOwnerOrSudo = require('../../lib/isOwner');
const { markAdminUpdate } = require('../../lib/adminUpdateTracker');
const { hasStaffRole } = require('../../lib/staffRoles');

const DEMOTE_THUMB_URL = 'https://files.catbox.moe/a34tts.png';
let demoteThumbCache = null;

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

async function getDemoteThumb() {
    if (!demoteThumbCache) {
        demoteThumbCache = await fetchBuffer(DEMOTE_THUMB_URL).catch(() => null);
    }
    return demoteThumbCache;
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
    return `@${String(jid).split('@')[0]}`;
}

function buildDemoteNotice(targets, byJid) {
    const demotedLine = `\u2B07\uFE0F demoted  ${targets.map(toTag).join('  ')}`;
    const byLine = byJid ? toTag(byJid) : 'System';

    return (
`\u26A0\uFE0F WISTORIA CONTROL

${demotedLine}
admin \u2192 member

by  ${byLine}
status  restricted`
    );
}

async function demoteCommand(sock, chatId, mentionedJids, message, options = {}) {
    try {
        if (!chatId.endsWith('@g.us')) {
            await sock.sendMessage(chatId, { text: 'This command can only be used in groups.' }, { quoted: message });
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
            await sock.sendMessage(chatId, { text: 'Make bot admin first.' }, { quoted: message });
            return;
        }
        if (!adminStatus.isSenderAdmin && !senderHasBypass) {
            await sock.sendMessage(chatId, { text: 'Only group admins can use .demote.' }, { quoted: message });
            return;
        }

        const guard = getGuardConfig(chatId);
        const senderIsOwnerOrSudo = await isOwnerOrSudo(senderJid).catch(() => false);
        const senderIsController = Boolean(guard.controllerJid) && normalizeJid(guard.controllerJid) === senderJid;

        if (guard.antiDemote && !senderIsOwnerOrSudo && !senderIsController) {
            await sock.sendMessage(chatId, {
                text: 'Anti-demote is enabled here. Only the controller or owner can demote admins.'
            }, { quoted: message });
            return;
        }

        let targets = [];
        if (mentionedJids && mentionedJids.length > 0) {
            targets = mentionedJids.map(normalizeJid).filter(Boolean);
        } else if (message.message?.extendedTextMessage?.contextInfo?.participant) {
            targets = [normalizeJid(message.message.extendedTextMessage.contextInfo.participant)].filter(Boolean);
        }

        if (!targets.length) {
            await sock.sendMessage(chatId, { text: 'Mention or reply to a user to demote.' }, { quoted: message });
            return;
        }

        markAdminUpdate(chatId, 'demote', targets);
        await sock.groupParticipantsUpdate(chatId, targets, 'demote');

        const byJid = normalizeJid(message.key.participant || message.key.remoteJid);
        const thumb = await getDemoteThumb();
        await sock.sendMessage(chatId, {
            text: buildDemoteNotice(targets, byJid),
            mentions: [...targets, byJid].filter(Boolean),
            contextInfo: {
                externalAdReply: {
                    title: 'DEMOTED',
                    body: 'admin to member',
                    mediaType: 1,
                    mediaUrl: '',
                    renderLargerThumbnail: false,
                    showAdAttribution: false,
                    sourceUrl: '',
                    ...(thumb ? { thumbnail: thumb } : {})
                }
            }
        });
    } catch (error) {
        console.error('Error in demote command:', error);
        await sock.sendMessage(chatId, { text: 'Failed to demote user.' }, { quoted: message });
    }
}

async function handleDemotionEvent(sock, groupId, participants, author) {
    try {
        if (!groupId || !participants) return;

        const targets = (participants || []).map(normalizeJid).filter(Boolean);
        if (!targets.length) return;

        const byJid = normalizeJid(author);
        const thumb = await getDemoteThumb();
        await sock.sendMessage(groupId, {
            text: buildDemoteNotice(targets, byJid),
            mentions: [...targets, byJid].filter(Boolean),
            contextInfo: {
                externalAdReply: {
                    title: 'DEMOTED',
                    body: 'admin to member',
                    mediaType: 1,
                    mediaUrl: '',
                    renderLargerThumbnail: false,
                    showAdAttribution: false,
                    sourceUrl: '',
                    ...(thumb ? { thumbnail: thumb } : {})
                }
            }
        });
    } catch (error) {
        console.error('Error handling demotion event:', error);
    }
}

module.exports = { demoteCommand, handleDemotionEvent };
