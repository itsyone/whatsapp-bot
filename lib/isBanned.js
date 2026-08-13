const fs = require('fs');
const { getTempBan } = require('./tempBan');

const BANNED_PATH = './data/banned.json';
let bannedCache = null;
let lastLoadAt = 0;
const LOAD_INTERVAL = 300_000; // Reload every 5 minutes

function isBanned(userId) {
    const now = Date.now();
    if (!bannedCache || now - lastLoadAt >= LOAD_INTERVAL) {
        try {
            if (!fs.existsSync(BANNED_PATH)) {
                fs.mkdirSync('./data', { recursive: true });
                fs.writeFileSync(BANNED_PATH, '[]', 'utf8');
                bannedCache = [];
            } else {
                bannedCache = JSON.parse(fs.readFileSync(BANNED_PATH, 'utf8'));
            }
            lastLoadAt = now;
        } catch (error) {
            console.error('[banned] refresh error:', error.message);
            bannedCache = bannedCache || [];
        }
    }

    try {
        if (getTempBan(userId)) return true;
        return Array.isArray(bannedCache) && bannedCache.includes(userId);
    } catch (error) {
        console.error('Error checking banned status:', error);
        return false;
    }
}

module.exports = { isBanned }; 
