const { buildOfficialLinkPreview } = require('../../lib/linkPreviewHelper');

const SUPPORT_LINK = 'https://chat.whatsapp.com/FLfT83WK6eGI1vEdOLJLrS';

const SUPPORT_TEXT = [
    '*Wistoria Community*',
    '',
    'Welcome to Wistoria.',
    'Join for bot updates, help, card drops, and community chat.',
    '',
    SUPPORT_LINK
].join('\n');

async function supportCommand(sock, chatId, message) {
    try {
        const linkPreview = await buildOfficialLinkPreview(sock, SUPPORT_LINK, {
            title: 'Wistoria Community',
            description: 'WhatsApp Group Invite'
        });
        return sock.sendMessage(chatId, {
            text: SUPPORT_TEXT,
            linkPreview
        }, { quoted: message }); // FIXED: shared official high-quality WhatsApp group preview
    } catch (error) {
        console.error('[support] preview send failed:', error?.message || error);
        return sock.sendMessage(chatId, {
            text: SUPPORT_TEXT
        }, { quoted: message }); // FIXED: plain-link fallback
    }
}

module.exports = {
    name: 'support',
    alias: ['community'],
    async execute(ctx) {
        return supportCommand(ctx.sock, ctx.chatId, ctx.message);
    }
};
