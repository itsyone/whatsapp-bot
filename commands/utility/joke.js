const axios = require('axios');

const _eclipseOriginalHandler = async  function(sock, chatId) {
    try {
        const response = await axios.get('https://icanhazdadjoke.com/', {
            headers: { Accept: 'application/json' }
        });
        const joke = response.data.joke;
        await sock.sendMessage(chatId, { text: joke });
    } catch (error) {
        console.error('Error fetching joke:', error);
        await sock.sendMessage(chatId, { text: 'Sorry, I could not fetch a joke right now.' });
    }
};


module.exports = {
  name: 'joke',
  async execute(ctx) {
    return _eclipseOriginalHandler(ctx.sock, ctx.chatId);
  }
};
