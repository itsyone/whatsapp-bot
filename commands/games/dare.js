const DARES = [
    'Send a 5 second voice note saying the first thing on your mind.',
    'Change your WhatsApp about to "I lost a dare" for 15 minutes.',
    'Compliment the last person who messaged before you.',
    'Send the most recent harmless photo from your gallery.',
    'Type a dramatic apology to the group for no reason.',
    'Send a voice note laughing without explaining why.',
    'Let the group choose your display name for 10 minutes.',
    'Tag someone and say one genuinely nice thing about them.',
    'Send a message using only uppercase for the next 5 minutes.',
    'Tell the group your most used emoji.'
];

function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
}

module.exports = {
    name: 'dare',
    aliases: ['dr'],
    async execute(ctx) {
        await ctx.sock.sendMessage(ctx.chatId, {
            text: `*Dare*\n\n> ${pick(DARES)}`
        }, { quoted: ctx.message });
    }
};
