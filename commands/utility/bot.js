async function botCommand(sock, chatId, message) {
    const infoMessage = [
        '*BOT INFO*',
        '',
        'Pairing from `.bot` is disabled.',
        'Use the main owner-managed pairing flow instead.',
        '',
        'Status: online'
    ].join('\n');

    try {
        await sock.sendMessage(chatId, {
            react: { text: '✅', key: message.key }
        });
    } catch {}

    await sock.sendMessage(chatId, { text: infoMessage }, { quoted: message });
}





module.exports = {
  name: 'bot',
  async execute(ctx) {
    return botCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
