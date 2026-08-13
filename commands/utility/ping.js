async function pingCommand(sock, chatId, message) {
    let latencyMs = 0;

    try {
        const msgTimestamp = message?.messageTimestamp;
        if (msgTimestamp) {
            latencyMs = Date.now() - (msgTimestamp * 1000);
            if (latencyMs < 0) latencyMs = 0; // clock skew
        }
    } catch {}

    const pongText = `*Pong | ${latencyMs}ms 🔵*`;

    try {
        await sock.sendMessage(chatId, { text: pongText }, { quoted: message });
    } catch (err) {
        console.error('[ping] error:', err.message);
        await sock.sendMessage(chatId, { text: pongText }, { quoted: message });
    }
}

module.exports = {
  name: 'ping',
  async execute(ctx) {
    return pingCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
