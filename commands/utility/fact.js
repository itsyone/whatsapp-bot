const axios = require('axios');

const _eclipseOriginalHandler = async function(sock, chatId, message) {
    try {
        const response = await axios.get('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en', {
            timeout: 8000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const fact = response.data.text;
        await sock.sendMessage(chatId, { text: `💡 *DID YOU KNOW?*\n\n${fact}` }, { quoted: message });
    } catch (error) {
        console.error('Error fetching fact:', error.message);
        await sock.sendMessage(chatId, { text: '⚠️ Sorry, I could not fetch a fact right now. The wisdom vault is currently locked.' }, { quoted: message });
    }
};


module.exports = {
  name: 'fact',
  async execute(ctx) {
    if (!ctx.sock || !ctx.chatId) return;
    return _eclipseOriginalHandler(ctx.sock, ctx.chatId, ctx.message);
  }
};
