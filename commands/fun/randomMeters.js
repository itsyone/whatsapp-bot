function getTargetJid(message, senderId) {
    const ctx = message?.message?.extendedTextMessage?.contextInfo || {};
    return (Array.isArray(ctx.mentionedJid) && ctx.mentionedJid[0]) || ctx.participant || senderId;
}

function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
}

const CONFIG = {
    horny: ['Horny', '🥵', 'desire scan'],
    femboy: ['Femboy', '🌸', 'softness scan'],
    stepsis: ['StepSis', '💞', 'anime family chaos scan'],
    stepmom: ['StepMom', '💋', 'forbidden aura scan'],
    stepbro: ['StepBro', '😳', 'caught-in-4k scan']
};

async function randomMeterCommand(ctx) {
    const cmd = String(ctx.userMessage || '').trim().split(/\s+/)[0].replace(/^\./, '').toLowerCase();
    const config = CONFIG[cmd];
    if (!config) return;

    const target = getTargetJid(ctx.message, ctx.senderId);
    const tag = `@${String(target || '').split('@')[0]}`;
    const percent = Math.floor(Math.random() * 101);
    const [label, emoji, subtitle] = config;
    const line = percent >= 80 ? pick(['dangerously high', 'maximum detected', 'out of control']) : percent >= 50 ? pick(['pretty strong', 'confirmed', 'not hiding it well']) : pick(['low but suspicious', 'barely detected', 'still loading']);

    await ctx.sock.sendMessage(ctx.chatId, {
        text: `${emoji} *${label} Meter*\n\n${tag} is *${percent}%* ${label.toLowerCase()}\n> ${subtitle}: ${line}`,
        mentions: [target]
    }, { quoted: ctx.message });
}

module.exports = [
    { name: 'horny', async execute(ctx) { return randomMeterCommand(ctx); } },
    { name: 'femboy', async execute(ctx) { return randomMeterCommand(ctx); } },
    { name: 'stepsis', async execute(ctx) { return randomMeterCommand(ctx); } },
    { name: 'stepmom', async execute(ctx) { return randomMeterCommand(ctx); } },
    { name: 'stepbro', async execute(ctx) { return randomMeterCommand(ctx); } }
];
