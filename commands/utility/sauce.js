async function sauceCommand(ctx) {
    const info = ctx.message?.message?.extendedTextMessage?.contextInfo || {};
    const quoted = info.quotedMessage || null;
    const text = String(ctx.args?.join(' ') || '').trim();

    if (!quoted && !text) {
        await ctx.sock.sendMessage(ctx.chatId, {
            text: 'Reply to an image/video or provide keywords.\nExample: .sauce anime screenshot'
        }, { quoted: ctx.message });
        return;
    }

    const urlLike = /^https?:\/\//i.test(text) ? text : '';
    const query = encodeURIComponent(text || 'anime image source');
    const urlParam = encodeURIComponent(urlLike);

    const lines = urlLike
        ? [
            '🔎 *Sauce Finder*',
            '',
            'Search links:',
            `• Google Lens: https://lens.google.com/uploadbyurl?url=${urlParam}`,
            `• SauceNAO: https://saucenao.com/search.php?url=${urlParam}`,
            `• TraceMoe: https://trace.moe/search?url=${urlParam}`,
            `• Web search: https://www.google.com/searchbyimage?image_url=${urlParam}`,
            '',
            'Tip: upload the quoted image to SauceNAO/TraceMoe for best results.'
        ]
        : [
            '🔎 *Sauce Finder*',
            '',
            'Search links:',
            '• Google Lens: https://lens.google.com/uploadbyurl',
            '• SauceNAO: https://saucenao.com/search.php',
            '• TraceMoe: https://trace.moe/',
            `• Web search: https://www.google.com/search?q=${query}`,
            '',
            'Tip: upload the quoted image to SauceNAO/TraceMoe for best results.'
        ];

    await ctx.sock.sendMessage(ctx.chatId, { text: lines.join('\n') }, { quoted: ctx.message });
}

module.exports = {
    name: 'sauce',
    aliases: ['source'],
    async execute(ctx) {
        return sauceCommand(ctx);
    }
};
