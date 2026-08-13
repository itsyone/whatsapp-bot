const fs = require('fs');
const path = require('path');

async function clearSessionCommand(sock, chatId, msg) {
    try {
        const sessionDir = path.join(process.cwd(), 'session'); // FIXED: absolute session path

        if (!fs.existsSync(sessionDir)) {
            await sock.sendMessage(chatId, {
                text: 'Session directory not found!'
            });
            return;
        }

        let filesCleared = 0;
        let errors = 0;
        const errorDetails = [];

        await sock.sendMessage(chatId, {
            text: 'Optimizing session files for better performance...'
        });

        const files = fs.readdirSync(sessionDir);
        let appStateSyncCount = 0;
        let preKeyCount = 0;

        for (const file of files) {
            if (file.startsWith('app-state-sync-')) appStateSyncCount++;
            if (file.startsWith('pre-key-')) preKeyCount++;
        }

        for (const file of files) {
            if (file === 'creds.json') continue;
            try {
                const filePath = path.join(sessionDir, file);
                fs.unlinkSync(filePath);
                filesCleared++;
            } catch (error) {
                errors++;
                errorDetails.push(`Failed to delete ${file}: ${error.message}`);
            }
        }

        const message =
            `Session files cleared successfully!\n\n` +
            `Statistics:\n` +
            `- Total files cleared: ${filesCleared}\n` +
            `- App state sync files: ${appStateSyncCount}\n` +
            `- Pre-key files: ${preKeyCount}\n` +
            (errors > 0 ? `\nErrors encountered: ${errors}\n${errorDetails.join('\n')}` : '');

        await sock.sendMessage(chatId, {
            text: message
        });
    } catch (error) {
        console.error('Error in clearsession command:', error);
        await sock.sendMessage(chatId, {
            text: 'Failed to clear session files!'
        });
    }
}





module.exports = {
  name: 'clearsession',
  permissionLevel: 'owner', // FIXED: central owner permission
  async execute(ctx) {
    return clearSessionCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null); // FIXED: ctx.message standardization
  }
};
