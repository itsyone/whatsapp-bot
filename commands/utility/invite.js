/**
 * Invite Command
 * Returns the group invitation link.
 * Accessible by anyone in the group.
 */

async function inviteCommand(sock, chatId, message) {
    try {
        const isGroup = chatId.endsWith('@g.us');
        if (!isGroup) {
            return await sock.sendMessage(chatId, { text: 'This command can only be used in groups.' }, { quoted: message });
        }

        // Attempt to get the invite code directly. 
        // Baileys will throw an error if the bot is not an admin.
        try {
            const inviteCode = await sock.groupInviteCode(chatId);
            const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;

            // Send ONLY the link, quoted to the user
            await sock.sendMessage(chatId, { 
                text: inviteLink 
            }, { 
                quoted: message,
                detectLinks: true 
            });
        } catch (err) {
            // Check if the error is related to privileges
            if (err.statusCode === 401 || err.statusCode === 403 || String(err).includes('not-authorized')) {
                return await sock.sendMessage(chatId, { 
                    text: 'Error: I need to be an **Admin** in this group to fetch the invite link.' 
                }, { quoted: message });
            }
            throw err; // Re-throw other errors to be caught by the outer catch
        }

    } catch (error) {
        console.error('Error in invite command:', error);
        await sock.sendMessage(chatId, { text: 'Failed to retrieve group invite link.' }, { quoted: message });
    }
}

module.exports = {
    name: 'invite',
    alias: ['glink', 'getlink'],
    async execute({ sock, chatId, message }) {
        await inviteCommand(sock, chatId, message);
    }
};
