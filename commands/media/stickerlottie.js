const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage, downloadMediaMessage } = require('../../lib/baileys');
const { writeExif } = require('../../lib/exif');
const settings = require('../../settings');
const { lottieToWebp } = require('../../services/lottieConverter');

function getStickerMeta() {
    return {
        packname: String(settings.packname || settings.botName || 'Sticker').trim() || 'Sticker',
        author: String(settings.author || 'Eclipse').trim() || 'Eclipse'
    };
}

async function stickerLottieCommand(sock, chatId, message, args = []) {
    const animationDir = path.resolve(process.cwd(), settings.animationDir || 'animation');
    
    // Check if replying to a document (JSON)
    const quoted = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const isDoc = quoted?.documentMessage || message.message?.documentMessage;
    
    if (isDoc) {
        const doc = quoted?.documentMessage || message.message?.documentMessage;
        if (doc.mimetype === 'application/json' || doc.fileName?.endsWith('.json')) {
            try {
                await sock.sendMessage(chatId, { react: { text: '🔄', key: message.key } });
                
                const buffer = await downloadMediaMessage(message, 'buffer', {}, {
                    logger: undefined,
                    reuploadRequest: sock.updateMediaMessage
                });
                
                const webpBuf = await lottieToWebp(JSON.parse(buffer.toString('utf8')));
                const stickerPath = await writeExif({ mimetype: 'image/webp', data: webpBuf }, getStickerMeta());
                
                await sock.sendMessage(chatId, { sticker: { url: stickerPath } }, { quoted: message });
                if (fs.existsSync(stickerPath)) fs.unlinkSync(stickerPath);
                
                await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });
                return;
            } catch (err) {
                console.error('[Lottie] Conversion error:', err);
                await sock.sendMessage(chatId, { text: `Failed to convert Lottie: ${err.message}` }, { quoted: message });
                return;
            }
        }
    }

    // Otherwise, handle local animation directory
    if (!fs.existsSync(animationDir)) {
        await sock.sendMessage(chatId, { text: `Animation directory not found: ${animationDir}` }, { quoted: message });
        return;
    }

    const files = fs.readdirSync(animationDir).filter(f => f.endsWith('.json'));
    
    if (files.length === 0) {
        await sock.sendMessage(chatId, { text: 'No Lottie animations found in local directory.' }, { quoted: message });
        return;
    }

    const index = parseInt(args[0]) - 1;
    if (isNaN(index) || index < 0 || index >= files.length) {
        const list = files.map((f, i) => `${i + 1}. ${f}`).join('\n');
        await sock.sendMessage(chatId, { 
            text: `Available Lottie Animations:\n\n${list}\n\nUse: .lottie <number>` 
        }, { quoted: message });
        return;
    }

    const targetFile = path.join(animationDir, files[index]);

    try {
        await sock.sendMessage(chatId, { react: { text: '🔄', key: message.key } });
        
        const webpBuf = await lottieToWebp(targetFile);
        const stickerPath = await writeExif({ mimetype: 'image/webp', data: webpBuf }, getStickerMeta());
        
        await sock.sendMessage(chatId, { sticker: { url: stickerPath } }, { quoted: message });
        if (fs.existsSync(stickerPath)) fs.unlinkSync(stickerPath);

        await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });
    } catch (err) {
        console.error('[Lottie] Error sending local animation:', err);
        await sock.sendMessage(chatId, { text: `Error: ${err.message}` }, { quoted: message });
    }
}

module.exports = {
    name: 'lottie',
    aliases: ['lt'],
    async execute(ctx) {
        const args = (ctx.args || []).map(a => String(a).trim());
        return stickerLottieCommand(ctx.sock, ctx.chatId, ctx.message, args);
    }
};
