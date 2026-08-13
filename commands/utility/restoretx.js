const { restoreLedgerEntry } = require('../../lib/rpg/economyFoundation');

module.exports = {
    name: 'restoretx',
    aliases: ['reversetx', 'undotx'],
    permissionLevel: 'owner',
    async execute(ctx) {
        const { sock, chatId, message, senderId, args = [] } = ctx;
        const txId = String(args[0] || '').trim();
        const reason = String(args.slice(1).join(' ') || 'manual restore').trim();

        if (!txId) {
            await sock.sendMessage(chatId, {
                text: 'Usage: .restoretx <tx_id> [reason]'
            }, { quoted: message });
            return;
        }

        const result = await restoreLedgerEntry({
            txId,
            actorJid: senderId,
            reason
        });

        if (!result?.ok) {
            await sock.sendMessage(chatId, {
                text: `Restore failed: ${result?.reason || 'unknown_error'}`
            }, { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, {
            text: [
                'Transaction restored.',
                `Original: ${result.originalTxId}`,
                `Reverse: ${result.reverseTxId}`,
                `Balance now: Y${Number(result.balance || 0).toLocaleString()}`
            ].join('\n')
        }, { quoted: message });
    }
};
