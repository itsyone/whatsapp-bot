const path = require('path');
const { getCurrentProfile } = require('./botContext');

function getBotId() {
    const profile = getCurrentProfile();
    return String(profile?.botId || 'eclipse').trim().toLowerCase() || 'eclipse';
}

function getBotDataDir() {
    return path.join(process.cwd(), 'data', 'bots', getBotId());
}

function getBotDataPath(fileName) {
    return path.join(getBotDataDir(), String(fileName || '').trim());
}

module.exports = {
    getBotId,
    getBotDataDir,
    getBotDataPath
};
