function formatDetailedUptime(secondsInput) {
    const totalSeconds = Math.max(0, Math.floor(Number(secondsInput || 0)));
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

function formatMemory(bytes) {
    return `${(Number(bytes || 0) / 1024 / 1024).toFixed(2)} MB`;
}

async function runtimeCommand(sock, chatId, message) {
    try {
        const uptime = formatDetailedUptime(process.uptime());
        const heapUsed = formatMemory(process.memoryUsage().heapUsed);
        const platform = `Node.js ${process.version}`;

        const runtimeText = [
            '*[ RUNTIME INFO ]*',
            '--------------------',
            `Uptime       : \`${uptime}\``,
            `Memory Usage : \`${heapUsed}\``,
            `Platform     : \`${platform}\``,
            '--------------------',
            'System info at a glance.'
        ].join('\n');

        await sock.sendMessage(chatId, { text: runtimeText }, { quoted: message });
    } catch (error) {
        console.error('[runtime] error:', error?.message || error);
        await sock.sendMessage(chatId, { text: 'Failed to read runtime info.' }, { quoted: message });
    }
}





module.exports = {
  name: 'runtime',
  async execute(ctx) {
    return runtimeCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
