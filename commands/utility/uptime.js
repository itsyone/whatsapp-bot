function formatDetailedUptime(secondsInput) {
    const totalSeconds = Math.max(0, Number(secondsInput || 0));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || parts.length) parts.push(`${hours}h`);
    if (minutes > 0 || parts.length) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    return parts.join(' ');
}

async function uptimeCommand(sock, chatId, message) {
    try {
        const uptimeSeconds = process.uptime();
        const totalHours = Math.floor(uptimeSeconds / 3600);
        const totalMinutes = Math.floor((uptimeSeconds % 3600) / 60);
        const totalSeconds = Math.floor(uptimeSeconds % 60);

        const uptimeText = [
            '*[ BOT UPTIME ]*',
            '--------------------',
            `Hours   : \`${totalHours}h\``,
            `Minutes : \`${totalMinutes}m\``,
            `Seconds : \`${totalSeconds}s\``,
            '--------------------',
            `Running steady for \`${formatDetailedUptime(uptimeSeconds)}\`.`
        ].join('\n');

        await sock.sendMessage(chatId, { text: uptimeText }, { quoted: message });
    } catch (error) {
        console.error('[uptime] error:', error?.message || error);
        await sock.sendMessage(chatId, { text: 'Failed to read bot uptime.' }, { quoted: message });
    }
}





module.exports = {
  name: 'uptime',
  async execute(ctx) {
    return uptimeCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
