const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('../../lib/baileys');
const { hasAdminBypass } = require('../../lib/adminBypass');

async function ensureGroupAndAdmin(sock, chatId, senderId) {
    const isGroup = chatId.endsWith('@g.us');
    if (!isGroup) {
        await sock.sendMessage(chatId, { text: 'This command can only be used in groups.' });
        return { ok: false };
    }

    const isAdmin = require('../../lib/isAdmin');
    const adminStatus = await isAdmin(sock, chatId, senderId);
    if (!adminStatus.isBotAdmin) {
        await sock.sendMessage(chatId, { text: 'Please make the bot an admin first.' });
        return { ok: false };
    }
    const bypass = await hasAdminBypass(null, senderId);
    if (!adminStatus.isSenderAdmin && !bypass) {
        await sock.sendMessage(chatId, { text: 'Only group admins can use this command.' });
        return { ok: false };
    }
    return { ok: true };
}

async function setGroupDescription(sock, chatId, senderId, text, message) {
    const check = await ensureGroupAndAdmin(sock, chatId, senderId);
    if (!check.ok) return;

    const desc = String(text || '').trim();
    if (!desc) {
        await sock.sendMessage(chatId, {
            text: '*SET GROUP DESCRIPTION*\n\nUse:\n.setgdesc <description>'
        }, { quoted: message });
        return;
    }

    try {
        await sock.groupUpdateDescription(chatId, desc);
        await sock.sendMessage(chatId, {
            text: '*SET GROUP DESCRIPTION*\n\nDescription updated successfully.'
        }, { quoted: message });
    } catch (_) {
        await sock.sendMessage(chatId, {
            text: '*SET GROUP DESCRIPTION*\n\nFailed to update description.'
        }, { quoted: message });
    }
}

async function setGroupName(sock, chatId, senderId, text, message) {
    const check = await ensureGroupAndAdmin(sock, chatId, senderId);
    if (!check.ok) return;

    const name = String(text || '').trim();
    if (!name) {
        await sock.sendMessage(chatId, {
            text: '*SET GROUP NAME*\n\nUse:\n.setgname <new name>'
        }, { quoted: message });
        return;
    }

    try {
        await sock.groupUpdateSubject(chatId, name);
        await sock.sendMessage(chatId, {
            text: '*SET GROUP NAME*\n\nGroup name updated successfully.'
        }, { quoted: message });
    } catch (_) {
        await sock.sendMessage(chatId, {
            text: '*SET GROUP NAME*\n\nFailed to update group name.'
        }, { quoted: message });
    }
}

async function setGroupPhoto(sock, chatId, senderId, message) {
    const check = await ensureGroupAndAdmin(sock, chatId, senderId);
    if (!check.ok) return;

    const quoted = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const imageMessage = quoted?.imageMessage || quoted?.stickerMessage;
    if (!imageMessage) {
        await sock.sendMessage(chatId, {
            text: '*SET GROUP PHOTO*\n\nReply to an image with:\n.setgpp'
        }, { quoted: message });
        return;
    }

    try {
        const tmpDir = path.join(process.cwd(), 'tmp');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        const stream = await downloadContentFromMessage(imageMessage, 'image');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

        const imgPath = path.join(tmpDir, `gpp_${Date.now()}.jpg`);
        fs.writeFileSync(imgPath, buffer);

        await sock.updateProfilePicture(chatId, { url: imgPath });
        try { fs.unlinkSync(imgPath); } catch {}

        await sock.sendMessage(chatId, {
            text: '*SET GROUP PHOTO*\n\nGroup photo updated successfully.'
        }, { quoted: message });
    } catch (_) {
        await sock.sendMessage(chatId, {
            text: '*SET GROUP PHOTO*\n\nFailed to update group photo.'
        }, { quoted: message });
    }
}

async function closeGroup(sock, chatId, senderId, message) {
    const check = await ensureGroupAndAdmin(sock, chatId, senderId);
    if (!check.ok) return;

    try {
        await sock.groupSettingUpdate(chatId, 'announcement');
        await sock.sendMessage(chatId, { text: 'Group closed. Only admins can send messages now.' }, { quoted: message });
    } catch (_) {
        await sock.sendMessage(chatId, { text: 'Failed to close the group.' }, { quoted: message });
    }
}

async function openGroup(sock, chatId, senderId, message) {
    const check = await ensureGroupAndAdmin(sock, chatId, senderId);
    if (!check.ok) return;

    try {
        await sock.groupSettingUpdate(chatId, 'not_announcement');
        await sock.sendMessage(chatId, { text: 'Group opened. Everyone can send messages now.' }, { quoted: message });
    } catch (_) {
        await sock.sendMessage(chatId, { text: 'Failed to open the group.' }, { quoted: message });
    }
}

module.exports = {
    setGroupDescription,
    setGroupName,
    setGroupPhoto,
    closeGroup,
    openGroup
};
