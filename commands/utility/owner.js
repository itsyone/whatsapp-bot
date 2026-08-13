const settings = require('../../settings');
async function ownerCommand(sock, chatId, message) {
    const vcard = `
BEGIN:VCARD
VERSION:3.0
FN:${settings.botOwner}
TEL;waid=${settings.ownerNumber}:${settings.ownerNumber}
END:VCARD
`.trim();

    try {
        await sock.sendMessage(chatId, {
            react: {
                text: '🔹',
                key: message.key
            }
        });
    } catch {}

    try {
        await sock.sendMessage(chatId, {
            text: [
                'Owner Info',
                `Name: ${settings.botOwner}`,
                `Number: ${settings.ownerNumber}`,
                '',
                'Contact owner for any help.'
            ].join('\n')
        }, { quoted: message });
    } catch (error) {
        console.error('Error sending owner text:', error);
    }

    try {
        await sock.sendMessage(chatId, {
            contacts: {
                displayName: settings.botOwner,
                contacts: [{ vcard }]
            }
        }, { quoted: message });
    } catch (error) {
        console.error('Error in owner command:', error);
    }
}

module.exports = {
  name: 'owner',
  async execute(ctx) {
    return ownerCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
