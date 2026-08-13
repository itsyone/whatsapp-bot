async function pairCommand(sock, chatId, message) {
    await sock.sendMessage(chatId, {
        text: 'Pairing from `.pair` is disabled for safety.\nUse the owner-managed terminal pairing flow only.'
    }, { quoted: message });
}

module.exports = {
    name: 'pair',
    async execute(ctx) {
        return pairCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
    }
};
