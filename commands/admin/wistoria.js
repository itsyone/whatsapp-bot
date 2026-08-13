const isAdmin = require('../../lib/isAdmin');
const { setWistoriaEnabled, isWistoriaEnabled } = require('../../lib/wistoriaState');

async function wistoriaCommand(sock, chatId, message, senderId, args) {
    if (!chatId.endsWith('@g.us')) {
        await sock.sendMessage(chatId, { text: 'This command only works in groups.' }, { quoted: message });
        return;
    }

    const { isSenderAdmin } = await isAdmin(sock, chatId, senderId);
    if (!isSenderAdmin) {
        await sock.sendMessage(chatId, { text: 'Only group admins can use `.wistoria`.' }, { quoted: message });
        return;
    }

    const mode = String(Array.isArray(args) ? args[0] : args || '').trim().toLowerCase();
    if (!['on', 'off'].includes(mode)) {
        const enabled = isWistoriaEnabled(chatId);
        await sock.sendMessage(chatId, { text: `Usage: .wistoria on/off\nCurrent status: ${enabled ? 'ON' : 'OFF'}` }, { quoted: message });
        return;
    }

    const enabled = mode === 'on';
    setWistoriaEnabled(chatId, enabled);
    await sock.sendMessage(chatId, { text: `Wistoria is now ${enabled ? 'ON' : 'OFF'} for this group.` }, { quoted: message });
}

module.exports = {
    name: 'wistoria',
    async execute(ctx) {
        return wistoriaCommand(ctx.sock, ctx.chatId, ctx.message, ctx.senderId, ctx.args);
    }
};
