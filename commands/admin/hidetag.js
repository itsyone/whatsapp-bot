const isAdmin = require('../../lib/isAdmin');
const { downloadContentFromMessage } = require('../../lib/baileys');
const fs = require('fs');
const path = require('path');
const { hasAdminBypass } = require('../../lib/adminBypass');

async function downloadMediaMessage(message, mediaType) {
    const stream = await downloadContentFromMessage(message, mediaType);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    const filePath = path.join(__dirname, '../tmp/', `${Date.now()}.${mediaType}`);
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

async function hideTagCommand(sock, chatId, senderId, messageText, replyMessage, message) {
    const bypass = await hasAdminBypass(message, senderId);
    const { isSenderAdmin, isBotAdmin } = await isAdmin(sock, chatId, senderId);

    if (!isBotAdmin) {
        await sock.sendMessage(chatId, { text: 'Please make the bot an admin first.' }, { quoted: message });
        return;
    }

    if (!isSenderAdmin && !bypass) {
        await sock.sendMessage(chatId, { text: '❌ *Access Denied*\n\nOnly group admins can use the *.hidetag* command.' }, { quoted: message });
        return;
    }

    const groupMetadata = await sock.groupMetadata(chatId);
    const participants = groupMetadata.participants || [];
    const mentions = participants.map((p) => p.id).filter(Boolean);

    try {
        await sock.sendMessage(chatId, { delete: message.key });
    } catch {}

    if (replyMessage) {
        let content = {};
        if (replyMessage.imageMessage) {
            const filePath = await downloadMediaMessage(replyMessage.imageMessage, 'image');
            content = { image: { url: filePath }, caption: messageText || replyMessage.imageMessage.caption || '', mentions };
        } else if (replyMessage.videoMessage) {
            const filePath = await downloadMediaMessage(replyMessage.videoMessage, 'video');
            content = { video: { url: filePath }, caption: messageText || replyMessage.videoMessage.caption || '', mentions };
        } else if (replyMessage.conversation || replyMessage.extendedTextMessage) {
            content = { text: messageText || replyMessage.conversation || replyMessage.extendedTextMessage.text, mentions };
        } else if (replyMessage.documentMessage) {
            const filePath = await downloadMediaMessage(replyMessage.documentMessage, 'document');
            content = { document: { url: filePath }, fileName: replyMessage.documentMessage.fileName, caption: messageText || '', mentions };
        }

        if (Object.keys(content).length > 0) {
        await sock.sendMessage(chatId, content);
    }
    } else {
        await sock.sendMessage(chatId, { text: messageText || '', mentions });
    }
}





module.exports = {
  name: 'hidetag',
  permissionLevel: 'admin', // FIXED: central admin permission
  async execute(ctx) {
    const rawText = String(ctx.rawText || ctx.userMessage || '').trim();
    const messageText = rawText.replace(/^\.hidetag\b/i, '').trim();
    const replyMessage =
      ctx.message?.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
      ctx.message?.message?.imageMessage?.contextInfo?.quotedMessage ||
      ctx.message?.message?.videoMessage?.contextInfo?.quotedMessage ||
      null;
    return hideTagCommand(ctx.sock || null, ctx.chatId || null, ctx.senderId || null, messageText, replyMessage, ctx.message || null);
  }
};
