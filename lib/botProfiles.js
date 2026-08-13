const fs = require('fs');
const path = require('path');

const BOT_CONFIG_DIR = path.join(process.cwd(), 'data', 'bots');

const APP_DEFAULTS = {
    storeWriteInterval: 120000,
    maxStoreMessages: 40,
    version: '1.0.0',
    fps: 15,
    quality: 75,
    chatbotStickerDir: path.join('assets', 'new stickers'),
    PREFIX: '/',
    autoReplies: {},
    profiles: []
};

function normalizeList(value) {
    return Array.isArray(value)
        ? [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
        : [];
}

function ensureDir() {
    fs.mkdirSync(BOT_CONFIG_DIR, { recursive: true });
}

function loadJson(filePath, fallback = {}) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function normalizeProfile(input = {}, defaults = APP_DEFAULTS) {
    const botId = String(input.botId || '').trim().toLowerCase();
    if (!botId) return null;

    const prefix = String(input.prefix || defaults.PREFIX || '/').trim() || '/';
    const profile = {
        botId,
        botName: String(input.botName || botId).trim() || botId,
        packname: String(input.packname || input.botName || botId).trim() || botId,
        author: String(input.author || defaults.author || 'Eclipse').trim() || 'Eclipse',
        botOwner: String(input.botOwner || defaults.botOwner || 'AYAN').trim() || 'AYAN',
        ownerNumber: String(input.ownerNumber || defaults.ownerNumber || '').replace(/[^\d]/g, ''),
        pairingNumber: String(input.pairingNumber || '').replace(/[^\d]/g, ''),
        pairingMode: String(input.pairingMode || '').trim().toLowerCase() === 'qr' ? 'qr' : 'code',
        prefix,
        sessionDir: path.join(process.cwd(), 'session', botId),
        assetDir: String(input.assetDir || path.join('assets', botId)).trim(),
        chatbotStickerDir: String(input.chatbotStickerDir || defaults.chatbotStickerDir || path.join('assets', 'new stickers')).trim(),
        enabledCommands: normalizeList(input.enabledCommands),
        disabledCommands: normalizeList(input.disabledCommands),
        aliases: input.aliases && typeof input.aliases === 'object' && !Array.isArray(input.aliases) ? input.aliases : {},
        autoReplies: input.autoReplies && typeof input.autoReplies === 'object' && !Array.isArray(input.autoReplies)
            ? input.autoReplies
            : (defaults.autoReplies || {}),
        characterProfile: input.characterProfile && typeof input.characterProfile === 'object' && !Array.isArray(input.characterProfile)
            ? input.characterProfile
            : null,
        helpImageUrl: String(input.helpImageUrl || '').trim(),
        chatbotProviders: normalizeList(input.chatbotProviders),
        hfApiKey: String(input.hfApiKey || '').trim(),
        openaiApiKey: String(input.openaiApiKey || '').trim(),
        groqApiKey: String(input.groqApiKey || '').trim(),
        geminiApiKey: String(input.geminiApiKey || '').trim(),
        settings: input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings) ? input.settings : {}
    };

    return profile;
}

function ensureDefaultProfiles() {
    ensureDir();
    const eclipsePath = path.join(BOT_CONFIG_DIR, 'eclipse.json');

    if (!fs.existsSync(eclipsePath)) {
        fs.writeFileSync(eclipsePath, JSON.stringify({
            botId: 'eclipse',
            botName: 'Eclipse',
            packname: 'Ryo Yamada',
            author: 'Eclipse',
            botOwner: 'AYAN',
            ownerNumber: '584164385530',
            prefix: '/',
            assetDir: 'assets',
            chatbotStickerDir: 'assets/new stickers',
            aliases: {},
            disabledCommands: [],
            enabledCommands: []
        }, null, 2), 'utf8');
    }

}

function getDisabledProfileIds() {
    ensureDir();
    return new Set(
        fs.readdirSync(BOT_CONFIG_DIR)
            .filter((file) => file.endsWith('.json.disabled') || file.endsWith('.json.server-disabled'))
            .map((file) => file.replace(/\.json\.(disabled|server-disabled)$/i, '').trim().toLowerCase())
            .filter(Boolean)
    );
}

function loadBotProfiles(baseSettings = {}) {
    const defaults = {
        ...APP_DEFAULTS,
        ...(baseSettings && typeof baseSettings === 'object' ? baseSettings : {})
    };
    ensureDefaultProfiles();
    const disabledProfileIds = getDisabledProfileIds();

    const profiles = fs.readdirSync(BOT_CONFIG_DIR)
        .filter((file) => file.endsWith('.json'))
        .filter((file) => !disabledProfileIds.has(file.replace(/\.json$/i, '').trim().toLowerCase()))
        .map((file) => normalizeProfile(loadJson(path.join(BOT_CONFIG_DIR, file), {}), defaults))
        .filter(Boolean);

    const fallback = normalizeProfile({
        botId: 'eclipse',
        botName: defaults.botName || 'Eclipse',
        packname: defaults.packname || defaults.botName || 'Eclipse',
        author: defaults.author || 'Eclipse',
        botOwner: defaults.botOwner || 'AYAN',
        ownerNumber: defaults.ownerNumber || '',
        prefix: defaults.PREFIX || '/',
        chatbotStickerDir: defaults.chatbotStickerDir,
        aliases: {}
    }, defaults);

    return profiles.length ? profiles : [fallback];
}

module.exports = {
    APP_DEFAULTS,
    BOT_CONFIG_DIR,
    loadBotProfiles,
    normalizeProfile
};
