const { getBotId } = require('../botDataPath');
const { ensureMongoReady } = require('../mongoStore');
const { LocalePreferenceModel } = require('./models');
const { normalizeBotId, normalizePlayerJid } = require('./identity');

const STRINGS = {
    en: {
        wallet_added: 'Added {{amount}} to {{target}}.',
        wallet_balance: 'New balance: {{balance}}',
        language_updated: 'Language set to {{locale}}.',
        language_usage: 'Use `.setlang en`.'
    }
};

function interpolate(template, params = {}) {
    return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, key) => String(params[key] ?? ''));
}

async function setLocale(jid, locale, botId = getBotId()) {
    await ensureMongoReady(botId).catch(() => false);
    const normalizedLocale = String(locale || 'en').trim().toLowerCase() || 'en';
    const now = Date.now();
    await LocalePreferenceModel.updateOne(
        { bot_id: normalizeBotId(botId), jid: normalizePlayerJid(jid) },
        {
            bot_id: normalizeBotId(botId),
            jid: normalizePlayerJid(jid),
            locale: normalizedLocale,
            updated_at: now,
            $setOnInsert: { created_at: now }
        },
        { upsert: true }
    );
    return normalizedLocale;
}

async function getLocale(jid, botId = getBotId()) {
    await ensureMongoReady(botId).catch(() => false);
    const doc = await LocalePreferenceModel.findOne({
        bot_id: normalizeBotId(botId),
        jid: normalizePlayerJid(jid)
    }).lean();
    return String(doc?.locale || 'en').trim().toLowerCase() || 'en';
}

async function t(jid, key, params = {}, botId = getBotId()) {
    const locale = await getLocale(jid, botId);
    const table = STRINGS[locale] || STRINGS.en;
    return interpolate(table[key] || STRINGS.en[key] || key, params);
}

module.exports = {
    STRINGS,
    setLocale,
    getLocale,
    t
};
