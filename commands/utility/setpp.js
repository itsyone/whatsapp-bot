const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('../../lib/baileys');

async function setProfilePicture(sock, chatId, msg) {
    try {
        const quotedMessage = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!quotedMessage) {
            await sock.sendMessage(chatId, {
                text: '⚠️ Please reply to an image with the .setpp command!' // FIXED: cracked warning emoji
            });
            return;
        }

        const imageMessage = quotedMessage.imageMessage || quotedMessage.stickerMessage;
        if (!imageMessage) {
            await sock.sendMessage(chatId, {
                text: '❌ The replied message must contain an image!' // FIXED: cracked error emoji
            });
            return;
        }

        const tmpDir = path.join(process.cwd(), 'tmp');
        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
        }

        const stream = await downloadContentFromMessage(imageMessage, 'image');
        let buffer = Buffer.from([]);

        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        const imagePath = path.join(tmpDir, `profile_${Date.now()}.jpg`);
        fs.writeFileSync(imagePath, buffer);
        await sock.updateProfilePicture(sock.user.id, { url: imagePath });
        fs.unlinkSync(imagePath);

        await sock.sendMessage(chatId, {
            text: '✅ Successfully updated bot profile picture!' // FIXED: cracked success emoji
        });
    } catch (error) {
        console.error('Error in setpp command:', error);
        await sock.sendMessage(chatId, {
            text: '❌ Failed to update profile picture!' // FIXED: cracked error emoji
        });
    }
}

module.exports = {
  name: 'setpp',
  permissionLevel: 'owner', // FIXED: central owner permission
  async execute(ctx) {
    return setProfilePicture(ctx.sock || null, ctx.chatId || null, ctx.message || null); // FIXED: ctx.message standardization
  }
};
