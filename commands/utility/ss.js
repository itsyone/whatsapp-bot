const fetch = require('node-fetch');

async function handleSsCommand(sock, chatId, message, match) {
    if (!match) {
        await sock.sendMessage(chatId, {
            text: '*SCREENSHOT TOOL*\n\nUse:\n.ss <url>\n.ssweb <url>\n.screenshot <url>'
        }, { quoted: message });
        return;
    }

    try {
        await sock.presenceSubscribe(chatId);
        await sock.sendPresenceUpdate('composing', chatId);

        const url = String(match || '').trim();
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            await sock.sendMessage(chatId, {
                text: 'Please provide a valid URL starting with http:// or https://'
            }, { quoted: message });
            return;
        }

        const apiUrl = `https://api-rebix.vercel.app/api/ssweb?url=${encodeURIComponent(url)}&device=full`;
        const response = await fetch(apiUrl, { headers: { accept: '*/*' } });
        if (!response.ok) {
            throw new Error(`API responded with status: ${response.status}`);
        }

        const imageBuffer = await response.buffer();
        await sock.sendMessage(chatId, { image: imageBuffer }, { quoted: message });
    } catch (error) {
        console.error('[ss] error:', error);
        await sock.sendMessage(chatId, {
            text: 'Failed to take screenshot. Try again in a moment.'
        }, { quoted: message });
    }
}





module.exports = {
  name: 'ss',
  async execute(ctx) {
    return handleSsCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.match || null);
  }
};
