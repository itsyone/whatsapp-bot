const { getAntiBotConfig, setAntiBotConfig, clearWarnings } = require('../../lib/antibot');
const isAdmin = require('../../lib/isAdmin');

async function antibotCommand(sock, chatId, message, senderId, rawText) {
    if (!chatId?.endsWith('@g.us')) {
        await sock.sendMessage(chatId, { text: 'Use `.antibot` in a group.' }, { quoted: message });
        return;
    }

    const adminStatus = await isAdmin(sock, chatId, senderId).catch(() => ({ isSenderAdmin: false, isBotAdmin: false }));

    if (!adminStatus.isSenderAdmin && !message?.key?.fromMe) {
        await sock.sendMessage(chatId, { text: 'admins only.' }, { quoted: message });
        return;
    }

    const parts = String(rawText || '').trim().split(/\s+/);
    const action = String(parts[1] || '').toLowerCase();
    const value = String(parts[2] || '').toLowerCase();

    if (!action) {
        await sock.sendMessage(chatId, {
            text: [
                '*ANTIBOT*',
                '.antibot on',
                '.antibot off',
                '.antibot get',
                '.antibot warn',
                '.antibot delete',
                '.antibot remove',
                '.antibot sensitivity <low|medium|high>',
                '.antibot reset'
            ].join('\n')
        }, { quoted: message });
        return;
    }

    if (action === 'get' || action === 'status') {
        const config = getAntiBotConfig(chatId);
        await sock.sendMessage(chatId, {
            text: [
                '*ANTIBOT*',
                `status: ${config.enabled ? 'on' : 'off'}`,
                `mode: ${config.mode}`,
                `sensitivity: ${config.sensitivity}`,
                `max warnings: ${config.maxWarnings}`,
                `burst limit: ${config.burstMax}/${Math.round(config.burstWindowMs / 1000)}s`,
                `duplicate limit: ${config.duplicateMax}/${Math.round(config.duplicateWindowMs / 1000)}s`
            ].join('\n')
        }, { quoted: message });
        return;
    }

    if (action === 'reset') {
        clearWarnings(chatId);
        await sock.sendMessage(chatId, { text: 'Antibot warnings reset for this group.' }, { quoted: message });
        return;
    }

    if (action === 'on') {
        const mode = ['warn', 'delete', 'remove'].includes(value) ? value : getAntiBotConfig(chatId).mode;
        if (mode === 'remove' && !adminStatus.isBotAdmin) {
            await sock.sendMessage(chatId, { text: 'Make bot admin first to use remove mode.' }, { quoted: message });
            return;
        }
        const config = setAntiBotConfig(chatId, { enabled: true, mode });
        await sock.sendMessage(chatId, {
            text: `Antibot is now ON.\nmode: ${config.mode}`
        }, { quoted: message });
        return;
    }

    if (action === 'sensitivity') {
        if (!['low', 'medium', 'high'].includes(value)) {
            await sock.sendMessage(chatId, { text: 'Use `.antibot sensitivity low|medium|high`.' }, { quoted: message });
            return;
        }
        const config = setAntiBotConfig(chatId, { sensitivity: value });
        await sock.sendMessage(chatId, {
            text: `Antibot sensitivity set to ${config.sensitivity}.`
        }, { quoted: message });
        return;
    }

    if (action === 'off') {
        const config = setAntiBotConfig(chatId, { enabled: false });
        await sock.sendMessage(chatId, {
            text: `Antibot is now OFF.\nmode: ${config.mode}`
        }, { quoted: message });
        return;
    }

    if (['warn', 'delete', 'remove'].includes(action)) {
        if (action === 'remove' && !adminStatus.isBotAdmin) {
            await sock.sendMessage(chatId, { text: 'Make bot admin first to use remove mode.' }, { quoted: message });
            return;
        }
        const config = setAntiBotConfig(chatId, { enabled: true, mode: action });
        await sock.sendMessage(chatId, {
            text: `Antibot mode set to ${config.mode}.`
        }, { quoted: message });
        return;
    }

    await sock.sendMessage(chatId, { text: 'Use `.antibot on/off/get/warn/delete/remove/sensitivity/reset`.' }, { quoted: message });
}

module.exports = {
    name: 'antibot',
    permissionLevel: 'admin', // FIXED: central admin permission
    async execute(ctx) {
        return antibotCommand(
            ctx.sock || null,
            ctx.chatId || null,
            ctx.message || null,
            ctx.senderId || null,
            ctx.rawText || ''
        );
    }
};
