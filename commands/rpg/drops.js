const { setDropsEnabled, getDropStatus, buildStatusText } = require('../../lib/dropSystem');

async function dropsCommand(sock, chatId, message, rawText, isOwner = false) {
    const parts = String(rawText || '').trim().split(/\s+/);
    const action = String(parts[1] || 'status').toLowerCase();

    if (!chatId.endsWith('@g.us')) {
        await sock.sendMessage(chatId, {
            text: 'This command only works in groups.'
        }, { quoted: message });
        return;
    }

    if (action === 'on') {
        if (!isOwner) {
            await sock.sendMessage(chatId, {
                text: 'Only the owner/sudo can turn drops on.'
            }, { quoted: message });
            return;
        }
        setDropsEnabled(chatId, true);
        await sock.sendMessage(chatId, {
            text: '🎲 Drops are now ON for this group.\n> auto spawns need 10 active users\n> max 2 drops every 24h'
        }, { quoted: message });
        return;
    }

    if (action === 'off') {
        if (!isOwner) {
            await sock.sendMessage(chatId, {
                text: 'Only the owner/sudo can turn drops off.'
            }, { quoted: message });
            return;
        }
        setDropsEnabled(chatId, false);
        await sock.sendMessage(chatId, {
            text: '🎲 Drops are now OFF for this group.'
        }, { quoted: message });
        return;
    }

    const status = getDropStatus(chatId);
    await sock.sendMessage(chatId, {
        text: buildStatusText(status)
    }, { quoted: message });
}





module.exports = {
  name: 'drops',
  async execute(ctx) {
    return dropsCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.rawText || null, Boolean(ctx.isOwner));
  }
};
