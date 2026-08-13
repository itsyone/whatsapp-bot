const settings = require('../../settings');

async function aliveCommand(sock, chatId, message) {
    try {
        await sock.sendMessage(chatId, {
            react: {
                text: '✅',
                key: message.key
            }
        });

        const aliveMessage = `Bot Status: Online
Mode: Public
Version: ${settings.version || '1.0.0'}

Bot is active and running!

Features:
• Group Management
• Antilink Protection
• Fun Commands
• AI Commands
• Downloader
• More Features

Type .menu for full command list`;

        await sock.sendMessage(chatId, {
            text: aliveMessage
        }, { quoted: message });
    } catch (error) {
        console.error('Error in alive command:', error);
        await sock.sendMessage(chatId, { 
            text: 'Bot is alive and running! ✅' 
        }, { quoted: message });
    }
}





module.exports = {
  name: 'alive',
  async execute(ctx) {
    return aliveCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
