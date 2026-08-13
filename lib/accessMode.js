const fs = require('fs');
const path = require('path');

const BOT_CONFIG_DIR = path.join(process.cwd(), 'data', 'bots');
const GLOBAL_MODE_PATH = path.join(process.cwd(), 'data', 'messageCount.json');

function getModePath(botId) {
    if (!botId) return GLOBAL_MODE_PATH;
    return path.join(BOT_CONFIG_DIR, `${botId}_mode.json`);
}

function readAccessModeState(botId) {
    const modePath = getModePath(botId);
    try {
        if (!fs.existsSync(modePath)) {
            // Fallback to global if bot-specific doesn't exist yet
            if (botId && fs.existsSync(GLOBAL_MODE_PATH)) {
                const globalData = JSON.parse(fs.readFileSync(GLOBAL_MODE_PATH, 'utf8'));
                return { accessMode: globalData?.isPublic === false ? 'private' : 'group' };
            }
            return { accessMode: 'group' };
        }

        const data = JSON.parse(fs.readFileSync(modePath, 'utf8'));
        const mode = String(data?.accessMode || '').trim().toLowerCase();

        if (mode === 'private' || mode === 'group' || mode === 'public') {
            return { accessMode: mode };
        }
        return { accessMode: data?.isPublic === false ? 'private' : 'group' };
    } catch {
        return { accessMode: 'group' };
    }
}

function writeAccessModeState(botId, mode) {
    const nextMode = String(mode || 'group').trim().toLowerCase();
    const safeMode = nextMode === 'private' || nextMode === 'group' || nextMode === 'public'
        ? nextMode
        : 'group';

    const next = {
        accessMode: safeMode,
        isPublic: safeMode === 'public'
    };

    const modePath = getModePath(botId);
    fs.mkdirSync(path.dirname(modePath), { recursive: true });
    fs.writeFileSync(modePath, JSON.stringify(next, null, 2));
    return next;
}

function canUseInMode(mode, { isGroup = false, isOwner = false } = {}) {
    const safeMode = String(mode || 'public').trim().toLowerCase();
    if (isOwner) return true;
    if (safeMode === 'public') return true;
    if (safeMode === 'private') return false;
    if (safeMode === 'group') return Boolean(isGroup);
    return true;
}

module.exports = {
    canUseInMode,
    readAccessModeState,
    writeAccessModeState
};
