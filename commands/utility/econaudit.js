const { listLedgerEntries } = require('../../lib/rpg/economyFoundation');
const { resolveRegisteredJid } = require('../../lib/registrationStore');

function extractMentionedJid(message) {
    const mentioned = message?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentioned[0]) return mentioned[0];
    const quotedParticipant = message?.message?.extendedTextMessage?.contextInfo?.participant;
    if (quotedParticipant) return quotedParticipant;
    return '';
}

function extractNumberTarget(args = []) {
    for (const part of args) {
        const cleaned = String(part || '').replace(/[^\d]/g, '');
        if (cleaned.length >= 7) return `${cleaned}@s.whatsapp.net`;
    }
    return '';
}

function extractLimit(args = []) {
    for (let i = args.length - 1; i >= 0; i -= 1) {
        const value = Number(args[i]);
        if (Number.isFinite(value) && value > 0) {
            return Math.max(1, Math.min(15, Math.floor(value)));
        }
    }
    return 5;
}

function formatMoney(value) {
    const amount = Number(value || 0);
    return `${amount >= 0 ? '+' : '-'}Y${Math.abs(amount).toLocaleString()}`;
}

function shortId(value) {
    return String(value || '').split('@')[0].split(':')[0];
}

module.exports = {
    name: 'econaudit',
    aliases: ['txaudit', 'ledgeraudit', 'auditbal'],
    permissionLevel: 'owner',
    async execute(ctx) {
        const { sock, chatId, message, senderId, args = [] } = ctx;
        const mentionTarget = extractMentionedJid(message);
        const numericTarget = extractNumberTarget(args);
        const resolvedTarget = resolveRegisteredJid([mentionTarget, numericTarget, senderId]) || senderId;
        const limit = extractLimit(args);

        const rows = await listLedgerEntries({ jid: resolvedTarget, limit }).catch(() => []);
        if (!rows.length) {
            await sock.sendMessage(chatId, {
                text: `No ledger entries found for @${shortId(resolvedTarget)}.`,
                mentions: [resolvedTarget]
            }, { quoted: message });
            return;
        }

        const text = [
            `Economy Audit for @${shortId(resolvedTarget)}`,
            '',
            ...rows.map((entry, index) => {
                const when = new Date(Number(entry.created_at || Date.now())).toISOString().replace('T', ' ').slice(0, 19);
                return [
                    `${index + 1}. ${String(entry.source || 'unknown')} | ${formatMoney(entry.delta)}`,
                    `tx: ${entry.tx_id}`,
                    `before: Y${Number(entry.before || 0).toLocaleString()} -> after: Y${Number(entry.after || 0).toLocaleString()}`,
                    `time: ${when}`
                ].join('\n');
            })
        ].join('\n\n');

        await sock.sendMessage(chatId, {
            text,
            mentions: [resolvedTarget]
        }, { quoted: message });
    }
};
