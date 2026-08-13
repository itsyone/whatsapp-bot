const activeDuels = new Map();

function tag(jid) {
    return `@${String(jid || '').split('@')[0]}`;
}

function getTarget(ctx) {
    const info = ctx.message?.message?.extendedTextMessage?.contextInfo || {};
    return (Array.isArray(info.mentionedJid) && info.mentionedJid[0]) || info.participant || '';
}

function hpBar(hp) {
    const filled = Math.max(0, Math.min(10, Math.ceil(hp / 10)));
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

async function duelCommand(ctx) {
    if (!String(ctx.chatId || '').endsWith('@g.us')) {
        await ctx.sock.sendMessage(ctx.chatId, { text: 'This command works only in groups.' }, { quoted: ctx.message });
        return;
    }

    const sub = String(ctx.args?.[0] || '').toLowerCase();
    const key = ctx.chatId;
    const existing = activeDuels.get(key);

    if (sub === 'accept') {
        if (!existing || existing.target !== ctx.senderId) {
            await ctx.sock.sendMessage(ctx.chatId, { text: 'No duel challenge for you.' }, { quoted: ctx.message });
            return;
        }
        const challengerRoll = Math.floor(Math.random() * 100) + 1;
        const targetRoll = Math.floor(Math.random() * 100) + 1;
        const winner = challengerRoll >= targetRoll ? existing.challenger : existing.target;
        activeDuels.delete(key);
        await ctx.sock.sendMessage(ctx.chatId, {
            text: `⚔️ *Duel Result*\n\n${tag(existing.challenger)} rolled *${challengerRoll}*\n${tag(existing.target)} rolled *${targetRoll}*\n\n🏆 Winner: ${tag(winner)}`,
            mentions: [existing.challenger, existing.target]
        }, { quoted: ctx.message });
        return;
    }

    if (sub === 'decline') {
        if (existing && existing.target === ctx.senderId) activeDuels.delete(key);
        await ctx.sock.sendMessage(ctx.chatId, { text: 'Duel declined.' }, { quoted: ctx.message });
        return;
    }

    const target = getTarget(ctx);
    if (!target || target === ctx.senderId) {
        await ctx.sock.sendMessage(ctx.chatId, { text: 'Use: .duel @user\nThen they reply: .duel accept' }, { quoted: ctx.message });
        return;
    }

    activeDuels.set(key, { challenger: ctx.senderId, target, createdAt: Date.now() });
    await ctx.sock.sendMessage(ctx.chatId, {
        text: `⚔️ ${tag(ctx.senderId)} challenged ${tag(target)} to a duel!\n\n${tag(target)}, reply with *.duel accept* or *.duel decline*.\n\n${tag(ctx.senderId)} HP ${hpBar(100)}\n${tag(target)} HP ${hpBar(100)}`,
        mentions: [ctx.senderId, target]
    }, { quoted: ctx.message });
}

module.exports = {
    name: 'duel',
    async execute(ctx) {
        return duelCommand(ctx);
    }
};
