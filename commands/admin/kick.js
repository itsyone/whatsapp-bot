const isAdmin = require('../../lib/isAdmin');
const { hasAdminBypass } = require('../../lib/adminBypass');

function normalizeJid(value) {
    const val = String(value || '').trim();
    if (!val) return '';
    const base = val.split('@')[0].split(':')[0];
    const domain = val.includes('@') ? val.split('@')[1] : 's.whatsapp.net';
    return `${base}@${domain}`;
}

function sameUser(a, b) {
    const left = normalizeJid(a).split('@')[0];
    const right = normalizeJid(b).split('@')[0];
    return Boolean(left && right && left === right);
}

function participantIds(participant) {
    return [
        participant?.id,
        participant?.jid,
        participant?.participantAlt,
        participant?.lid,
        participant?.pn
    ].filter(Boolean).map(normalizeJid);
}

function collectQuotedParticipant(message) {
    const candidates = [
        message?.message?.extendedTextMessage?.contextInfo?.participant,
        message?.message?.imageMessage?.contextInfo?.participant,
        message?.message?.videoMessage?.contextInfo?.participant,
        message?.message?.documentMessage?.contextInfo?.participant,
        message?.message?.groupMentionedMessage?.message?.extendedTextMessage?.contextInfo?.participant
    ];
    return candidates.map(normalizeJid).find(Boolean) || '';
}

async function resolveTargets(sock, chatId, message, mentionedJids = []) {
    const metadata = await sock.groupMetadata(chatId);
    const requested = [];

    if (Array.isArray(mentionedJids) && mentionedJids.length) {
        requested.push(...mentionedJids.map(normalizeJid));
    }

    const quotedParticipant = collectQuotedParticipant(message);
    if (quotedParticipant) requested.push(quotedParticipant);

    const uniqueRequested = [...new Set(requested.filter(Boolean))];
    if (!uniqueRequested.length) return [];

    return uniqueRequested.map((target) => {
        const match = (metadata.participants || []).find((participant) =>
            participantIds(participant).some((candidate) => sameUser(candidate, target))
        );
        return match ? participantIds(match)[0] : target;
    }).filter(Boolean);
}

function isBotTarget(sock, candidateIds = []) {
    return candidateIds.some((candidate) =>
        [sock?.user?.id, sock?.user?.lid, sock?.user?.pn, sock?.user?.phoneNumber]
            .filter(Boolean)
            .some((botId) => sameUser(candidate, botId))
    );
}

function toTag(jid) {
    return `@${String(jid).split('@')[0].split(':')[0]}`;
}

async function kickCommand(sock, chatId, message, senderId, mentionedJids) {
    try {
        if (!chatId?.endsWith('@g.us')) {
            await sock.sendMessage(chatId, { text: 'Groups only.' }, { quoted: message });
            return;
        }

        const bypass = await hasAdminBypass(message, senderId);
        if (!bypass) {
            const { isSenderAdmin, isBotAdmin } = await isAdmin(sock, chatId, senderId);
            if (!isBotAdmin) {
                await sock.sendMessage(chatId, { text: 'Please make the bot an admin first.' }, { quoted: message });
                return;
            }
            if (!isSenderAdmin) {
                await sock.sendMessage(chatId, { text: 'Only group admins can use `.kick`.' }, { quoted: message });
                return;
            }
        }

        const targets = await resolveTargets(sock, chatId, message, mentionedJids);
        if (!targets.length) {
            await sock.sendMessage(chatId, {
                text: 'Mention a user or reply to their message to kick them.'
            }, { quoted: message });
            return;
        }

        if (isBotTarget(sock, targets)) {
            await sock.sendMessage(chatId, {
                text: "I can't kick myself."
            }, { quoted: message });
            return;
        }

        await sock.groupParticipantsUpdate(chatId, targets, 'remove');
        await sock.sendMessage(chatId, {
            text: `${targets.map(toTag).join(', ')} kicked successfully.`,
            mentions: targets
        }, { quoted: message });
    } catch (error) {
        console.error('Error in kick command:', error);
        const detail = String(error?.message || '').trim();
        await sock.sendMessage(chatId, {
            text: detail ? `Failed to kick user(s): ${detail}` : 'Failed to kick user(s).'
        }, { quoted: message });
    }
}

module.exports = {
    name: 'kick',
    permissionLevel: 'admin', // FIXED: central admin permission
    async execute(ctx) {
        return kickCommand(
            ctx.sock || null,
            ctx.chatId || null,
            ctx.message || null,
            ctx.senderId || null,
            ctx.mentionedJids || []
        );
    }
};
