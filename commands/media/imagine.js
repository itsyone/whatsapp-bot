const axios = require('axios');

function getPromptText(message) {
    return (
        message.message?.conversation?.trim() ||
        message.message?.extendedTextMessage?.text?.trim() ||
        message.message?.imageMessage?.caption?.trim() ||
        message.message?.videoMessage?.caption?.trim() ||
        ''
    );
}

function extractImagePrompt(rawText) {
    return String(rawText || '')
        .replace(/^\.(?:imagine|flux|dalle)\s*/i, '')
        .trim();
}

function enhancePrompt(prompt) {
    const qualityEnhancers = [
        'high quality',
        'detailed',
        'masterpiece',
        'best quality',
        '4k',
        'cinematic lighting',
        'sharp focus'
    ];

    const numEnhancers = Math.floor(Math.random() * 2) + 2;
    const selectedEnhancers = qualityEnhancers
        .sort(() => Math.random() - 0.5)
        .slice(0, numEnhancers);

    return `${prompt}, ${selectedEnhancers.join(', ')}`;
}

async function imagineCommand(sock, chatId, message) {
    try {
        const promptText = getPromptText(message);
        const imagePrompt = extractImagePrompt(promptText);

        if (!imagePrompt) {
            await sock.sendMessage(chatId, {
                text: 'Please provide a prompt.\nExample: `.imagine naruto with sakura in love`'
            }, { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, {
            text: 'Generating your AI image...'
        }, { quoted: message });

        const enhancedPrompt = enhancePrompt(imagePrompt);
        const response = await axios.get('https://api-rebix.vercel.app/api/dalle', {
            params: { q: enhancedPrompt },
            responseType: 'arraybuffer',
            timeout: 60000
        });

        const imageBuffer = Buffer.from(response.data);

        await sock.sendMessage(chatId, {
            image: imageBuffer,
            caption: `AI image for: ${imagePrompt}`
        }, { quoted: message });
    } catch (error) {
        console.error('Error in imagine command:', error);
        await sock.sendMessage(chatId, {
            text: 'Failed to generate image right now. Please try again later.'
        }, { quoted: message });
    }
}





module.exports = {
  name: 'imagine',
  async execute(ctx) {
    return imagineCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
