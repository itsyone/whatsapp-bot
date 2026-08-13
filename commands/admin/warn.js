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

async function warnCommand(sock, chatId, senderId, mentionedJids, message) {
    try {
        initializeWarningsFile();

        if (!chatId.endsWith('@g.us')) {
            await sock.sendMessage(chatId, {
                text: 'This command can only be used in groups!'
            });
            return;
        }

        try {
            const { isBotAdmin } = await isAdmin(sock, chatId, senderId);

            if (!isBotAdmin) {
                await sock.sendMessage(chatId, {
                    text: 'Error: Please make the bot an admin first to use this command.'
                });
                return;
            }

        } catch (adminError) {
            console.error('Error checking admin status:', adminError);
            await sock.sendMessage(chatId, {
                text: 'Error: Please make sure the bot is an admin of this group.'
            });
            return;
        }

        let userToWarn = '';

        if (mentionedJids && mentionedJids.length > 0) {
            userToWarn = mentionedJids[0];
        } else if (message.message?.extendedTextMessage?.contextInfo?.participant) {
            userToWarn = message.message.extendedTextMessage.contextInfo.participant;
        }

        userToWarn = normalizeWarnJid(userToWarn);

        if (!userToWarn) {
            await sock.sendMessage(chatId, {
                text: 'Error: Please mention the user or reply to their message to warn!'
            });
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));

        try {
            let warnings = {};
            try {
                warnings = JSON.parse(fs.readFileSync(warningsPath, 'utf8'));
            } catch {
                warnings = {};
            }

            if (!warnings[chatId]) warnings[chatId] = {};
            if (!warnings[chatId][userToWarn]) warnings[chatId][userToWarn] = 0;

            warnings[chatId][userToWarn] += 1;
            fs.writeFileSync(warningsPath, JSON.stringify(warnings, null, 2));

            const warningMessage =
                `*『 WARNING ALERT 』*\n\n` +
                `👤 *Warned User:* @${userToWarn.split('@')[0]}\n` +
                `⚠️ *Warning Count:* ${warnings[chatId][userToWarn]}/3\n` +
                `🧑‍⚖️ *Warned By:* @${senderId.split('@')[0]}\n\n` +
                `📅 *Date:* ${new Date().toLocaleString()}`;

            await sock.sendMessage(chatId, {
                text: warningMessage,
                mentions: [userToWarn, senderId]
            });

            if (warnings[chatId][userToWarn] >= 3) {
                await new Promise((resolve) => setTimeout(resolve, 1000));

                await sock.groupParticipantsUpdate(chatId, [userToWarn], 'remove');
                delete warnings[chatId][userToWarn];
                fs.writeFileSync(warningsPath, JSON.stringify(warnings, null, 2));

                const kickMessage =
                    `*『 AUTO-KICK 』*\n\n` +
                    `@${userToWarn.split('@')[0]} has been removed from the group after receiving 3 warnings! ⚠️`;

                await sock.sendMessage(chatId, {
                    text: kickMessage,
                    mentions: [userToWarn]
                });
            }
        } catch (error) {
            console.error('Error in warn command:', error);
            await sock.sendMessage(chatId, {
                text: 'Failed to warn user!'
            });
        }
    } catch (error) {
        console.error('Error in warn command:', error);
        if (error.data === 429) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            try {
                await sock.sendMessage(chatId, {
                    text: 'Rate limit reached. Please try again in a few seconds.'
                });
            } catch (retryError) {
                console.error('Error sending retry message:', retryError);
            }
        } else {
            try {
                await sock.sendMessage(chatId, {
                    text: 'Failed to warn user. Make sure the bot is admin and has sufficient permissions.'
                });
            } catch (sendError) {
                console.error('Error sending error message:', sendError);
            }
        }
    }
}





module.exports = {
  name: 'warn',
  permissionLevel: 'admin', // FIXED: central admin permission
  async execute(ctx) {
    return warnCommand(ctx.sock || null, ctx.chatId || null, ctx.senderId || null, ctx.mentionedJids || null, ctx.message || null);
  }
};
