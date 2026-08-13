const TRUTHS = [
    'What is one secret you have never told this group?',
    'Who was your last chat with, and what was it about?',
    'What is the most embarrassing thing in your gallery?',
    'Who in this group would you trust with your phone?',
    'What is a lie you recently told?',
    'Who do you miss but refuse to text first?',
    'What is your most childish habit?',
    'Who here do you think understands you best?',
    'What message did you delete recently?',
    'What is something you pretend not to care about?'
];

function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
}

module.exports = {
    name: 'truth',
    aliases: ['tq'],
    async execute(ctx) {
        await ctx.sock.sendMessage(ctx.chatId, {
            text: `*Truth*\n\n> ${pick(TRUTHS)}`
        }, { quoted: ctx.message });
    }
};
