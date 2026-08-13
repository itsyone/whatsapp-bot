const { reconcileEconomyStateFromLedger } = require('../../lib/economy');

function getTargetJid(ctx = {}) {
    const mentioned = ctx?.message?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentioned[0]) return mentioned[0];

    const quoted = ctx?.message?.message?.extendedTextMessage?.contextInfo?.participant;
    if (quoted) return quoted;

    const rawText = String(ctx?.rawText || '').trim();
    const parts = rawText.split(/\s+/).slice(1);
    for (const part of parts) {
        const digits = String(part || '').replace(/\D/g, '');
        if (digits.length >= 7) return `${digits}@s.whatsapp.net`;
    }
    return ctx?.senderId || '';
}

module.exports = {
    name: 'fixbank',
    aliases: ['repairbank', 'reconcilebank', 'fixecon', 'repairecon'],
    permissionLevel: 'owner',
    async execute(ctx) {
        const { sock, chatId, message } = ctx;
        const targetJid = getTargetJid(ctx);
        if (!targetJid) {
            await sock.sendMessage(chatId, { text: 'Usage: .fixbank @user' }, { quoted: message });
            return;
        }

        const result = await reconcileEconomyStateFromLedger(targetJid, { force: true });
        if (!result?.ok) {
            await sock.sendMessage(chatId, {
                text: `Economy repair failed: ${result?.reason || 'unknown_error'}`
            }, { quoted: message });
            return;
        }

        const banks = result.banks || {};
        const lines = [
            'Economy repair complete.',
            `Target: ${result.jid}`,
            `Wallet: ¥${Number(result.wallet || 0).toLocaleString()}`,
            `Wistoria: ¥${Number(banks.Wistoria || 0).toLocaleString()}`,
            `Neon: ¥${Number(banks.Neon || 0).toLocaleString()}`,
            `Vortex: ¥${Number(banks.Vortex || 0).toLocaleString()}`,
            `Titan: ¥${Number(banks.Titan || 0).toLocaleString()}`,
            `Glitch: ¥${Number(banks.Glitch || 0).toLocaleString()}`,
            `Ledger rows: ${Number(result.rows || 0).toLocaleString()}`,
            `Reset gaps repaired: ${Number(result.discontinuities || 0).toLocaleString()}`
        ];

        await sock.sendMessage(chatId, { text: lines.join('\n') }, { quoted: message });
    }
};
