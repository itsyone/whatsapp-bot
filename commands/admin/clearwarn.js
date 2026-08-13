const fs = require('fs');
const path = require('path');
const isAdmin = require('../../lib/isAdmin');

const databaseDir = path.join(process.cwd(), 'data');
const warningsPath = path.join(databaseDir, 'warnings.json');

function normalizeWarnJid(value) {
    const digits = String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');
    return digits ? `${digits}@s.whatsapp.net` : '';
}

function initializeWarningsFile() {
    if (!fs.existsSync(databaseDir)) {
        fs.mkdirSync(databaseDir, { recursive: true });
    }

    if (!fs.existsSync(warningsPath)) {
        fs.writeFileSync(warningsPath, JSON.stringify({}), 'utf8');
    }
}

function getTargetUser(message, mentionedJids = []) {
    if (mentionedJids.length > 0) return normalizeWarnJid(mentionedJids[0]);
    return normalizeWarnJid(message.message?.extendedTextMessage?.contextInfo?.participant || '');
}

async function clearWarnCommand(sock, chatId, senderId, mentionedJids, message) {
    try {
        initializeWarningsFile();

        if (!chatId.endsWith('@g.us')) {
            await sock.sendMessage(chatId, { text: 'This command can only be used in groups.' }, { quoted: message });
            return;
        }

        const { isBotAdmin } = await isAdmin(sock, chatId, senderId);

        if (!isBotAdmin) {
            await sock.sendMessage(chatId, { text: 'Please make the bot an admin first.' }, { quoted: message });
            return;
        }

        const targetUser = getTargetUser(message, mentionedJids);
        if (!targetUser) {
            await sock.sendMessage(chatId, { text: 'Mention a user or reply to their message to clear warnings.' }, { quoted: message });
            return;
        }

        let warnings = {};
        try {
            warnings = JSON.parse(fs.readFileSync(warningsPath, 'utf8'));
        } catch {
            warnings = {};
        }

        if (!warnings[chatId]) warnings[chatId] = {};
        let previousCount = 0;
        for (const [jid, count] of Object.entries(warnings[chatId])) {
            if (normalizeWarnJid(jid) === targetUser) {
                previousCount += Number(count || 0);
                delete warnings[chatId][jid];
            }
        }
        fs.writeFileSync(warningsPath, JSON.stringify(warnings, null, 2));

        await sock.sendMessage(chatId, {
            text:
                `*Warns Cleared*\n\n` +
                `User: @${targetUser.split('@')[0]}\n` +
                `Previous warns: ${previousCount}\n` +
                `Cleared by: @${senderId.split('@')[0]}`,
            mentions: [targetUser, senderId]
        }, { quoted: message });
    } catch (error) {
        console.error('Error in clearwarn command:', error);
        await sock.sendMessage(chatId, { text: 'Failed to clear warnings.' }, { quoted: message });
    }
}





module.exports = {
  name: 'clearwarn',
  permissionLevel: 'admin', // FIXED: central admin permission
  async execute(ctx) {
    return clearWarnCommand(ctx.sock || null, ctx.chatId || null, ctx.senderId || null, ctx.mentionedJids || null, ctx.message || null);
  }
};
