const { hasPermission, addSudo, removeSudo, getSudoList, isOwner } = require('../../lib/permissionHandler');
const { resolveRegisteredJid } = require('../../lib/registrationStore');

function extractMentionedJid(message) {
    const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentioned.length > 0) return mentioned[0];

    const text = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
    const match = text.match(/\b(\d{7,15})\b/);
    if (match) return `${match[1]}@s.whatsapp.net`;

    return null;
}

function formatTarget(jid) {
    return `@${String(jid || '').split('@')[0].split(':')[0]}`;
}

function resolveMentionTarget(jid) {
    const canonical = resolveRegisteredJid([jid]);
    return canonical || String(jid || '').trim(); // FIXED: sudo list mention resolution
}

async function sudoCommand(sock, chatId, message, senderId, args = []) {
    const sub = String(args[0] || '').toLowerCase();

    if (!sub || !['add', 'del', 'remove', 'list'].includes(sub)) {
        await sock.sendMessage(chatId, { text: 'Usage:\n.sudo add <@user|number>\n.sudo del <@user|number>\n.sudo list' }, { quoted: message });
        return;
    }

    const requiredLevel = sub === 'list' ? 'sudo' : 'owner';
    const allowed = await hasPermission(senderId, requiredLevel);
    if (!allowed) {
        await sock.sendMessage(chatId, { text: "You don't have permission to use this command." }, { quoted: message }); // FIXED: sudo list permission
        return;
    }

    if (sub === 'list') {
        const list = await getSudoList();
        if (!list.length) {
            await sock.sendMessage(chatId, { text: 'No sudo users set.' }, { quoted: message });
            return;
        }

        const mentionList = list.map((jid) => resolveMentionTarget(jid));
        const text = mentionList.map((jid, index) => `${index + 1}. ${formatTarget(jid)}`).join('\n');
        await sock.sendMessage(chatId, { text: `Sudo users:\n${text}`, mentions: mentionList }, { quoted: message });
        return;
    }

    const targetJid = extractMentionedJid(message);
    if (!targetJid) {
        await sock.sendMessage(chatId, { text: 'Please mention a user or provide a number.' }, { quoted: message });
        return;
    }

    if (sub === 'add') {
        const ok = await addSudo(targetJid);
        await sock.sendMessage(chatId, {
            text: ok ? `Added sudo: ${formatTarget(targetJid)}` : 'Failed to add sudo',
            mentions: ok ? [targetJid] : []
        }, { quoted: message });
        return;
    }

    if (await isOwner(targetJid)) {
        await sock.sendMessage(chatId, { text: 'Owner cannot be removed.' }, { quoted: message });
        return;
    }

    const ok = await removeSudo(targetJid);
    await sock.sendMessage(chatId, {
        text: ok ? `Removed sudo: ${formatTarget(targetJid)}` : 'Failed to remove sudo',
        mentions: ok ? [targetJid] : []
    }, { quoted: message });
}





module.exports = {
  name: 'sudo',
  permissionLevel: 'sudo', // FIXED: sudo command access level
  async execute(ctx) {
    return sudoCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null, ctx.args || []);
  }
};
