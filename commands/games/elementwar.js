const ELEMENTS = {
    fire: { emoji: '🔥', beats: 'nature' },
    water: { emoji: '💧', beats: 'fire' },
    nature: { emoji: '🌿', beats: 'earth' },
    earth: { emoji: '🪨', beats: 'air' },
    air: { emoji: '🌪️', beats: 'water' }
};

function pickElement() {
    const keys = Object.keys(ELEMENTS);
    return keys[Math.floor(Math.random() * keys.length)];
}

async function elementWarCommand(ctx) {
    const chosen = String(ctx.args?.[0] || '').toLowerCase();
    if (!ELEMENTS[chosen]) {
        await ctx.sock.sendMessage(ctx.chatId, { text: 'Use: .elementwar <fire|water|nature|earth|air>' }, { quoted: ctx.message });
        return;
    }

    const enemy = pickElement();
    const player = ELEMENTS[chosen];
    const foe = ELEMENTS[enemy];
    const won = player.beats === enemy;
    const lost = foe.beats === chosen;
    const result = won ? '🏆 You won the element war!' : lost ? '💀 You lost the element war!' : '🤝 Element clash ended in a draw.';

    await ctx.sock.sendMessage(ctx.chatId, {
        text: `⚔️ *Element War*\n\nYou: ${player.emoji} *${chosen}*\nEnemy: ${foe.emoji} *${enemy}*\n\n${result}`
    }, { quoted: ctx.message });
}

module.exports = {
    name: 'elementwar',
    aliases: ['ewar'],
    async execute(ctx) {
        return elementWarCommand(ctx);
    }
};
