const fs = require('fs');
const path = require('path');

let autoClearInterval = null;

// Function to clear a single directory
function clearDirectory(dirPath) {
    try {
        if (!fs.existsSync(dirPath)) {
            return { success: false, message: `Directory does not exist: ${dirPath}` };
        }
        const files = fs.readdirSync(dirPath);
        let deletedCount = 0;
        for (const file of files) {
            try {
                const filePath = path.join(dirPath, file);
                const stat = fs.lstatSync(filePath);
                if (stat.isDirectory()) {
                    fs.rmSync(filePath, { recursive: true, force: true });
                } else {
                    fs.unlinkSync(filePath);
                }
                deletedCount++;
            } catch (err) {
                console.error(`Error deleting file ${file}:`, err);
            }
        }
        return { success: true, message: `Cleared ${deletedCount} files in ${path.basename(dirPath)}`, count: deletedCount };
    } catch (error) {
        console.error('Error in clearDirectory:', error);
        return { success: false, message: `Failed to clear files in ${path.basename(dirPath)}`, error: error.message };
    }
}

// Function to clear both tmp and temp directories
async function clearTmpDirectory() {
    const tmpDir = path.join(process.cwd(), 'tmp');
    const tempDir = path.join(process.cwd(), 'temp');
    const results = [];
    results.push(clearDirectory(tmpDir));
    results.push(clearDirectory(tempDir));
    const success = results.every((result) => result.success);
    const totalDeleted = results.reduce((sum, result) => sum + (result.count || 0), 0);
    const message = results.map((result) => result.message).join(' | ');
    return { success, message, count: totalDeleted };
}

// Function to handle manual command
async function clearTmpCommand(sock, chatId) {
    try {
        const result = await clearTmpDirectory();

        if (result.success) {
            await sock.sendMessage(chatId, {
                text: `✅ ${result.message}` // FIXED: cracked success emoji
            });
        } else {
            await sock.sendMessage(chatId, {
                text: `❌ ${result.message}` // FIXED: cracked error emoji
            });
        }
    } catch (error) {
        console.error('Error in cleartmp command:', error);
        await sock.sendMessage(chatId, {
            text: '❌ Failed to clear temporary files!' // FIXED: cracked error emoji
        });
    }
}

// Start automatic clearing every 6 hours
function startAutoClear() {
    if (autoClearInterval) return autoClearInterval;

    clearTmpDirectory().then((result) => {
        if (!result.success) {
            console.error(`[Auto Clear] ${result.message}`);
        }
    });

    autoClearInterval = setInterval(async () => {
        const result = await clearTmpDirectory();
        if (!result.success) {
            console.error(`[Auto Clear] ${result.message}`);
        }
    }, 6 * 60 * 60 * 1000); // FIXED: explicit cleartmp scheduler init

    return autoClearInterval;
}

function init() {
    startAutoClear();
}

module.exports = {
  name: 'cleartmp',
  permissionLevel: 'sudo', // FIXED: central sudo permission
  init,
  async execute(ctx) {
    return clearTmpCommand(ctx.sock || null, ctx.chatId || null); // FIXED: ctx.message standardization
  }
};
