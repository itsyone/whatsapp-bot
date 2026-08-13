const { getBotId } = require('../botDataPath');
const { ensureMongoReady } = require('../mongoStore');
const { GuildModel } = require('./models');
const { normalizeBotId, normalizePlayerJid } = require('./identity');

function makeGuildId(botId, name) {
    return `${normalizeBotId(botId)}:guild:${String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${Date.now()}`;
}

async function createGuild({ botId = getBotId(), ownerJid, name, locale = 'en' } = {}) {
    await ensureMongoReady(botId).catch(() => false);
    const normalizedOwner = normalizePlayerJid(ownerJid);
    const guild = await GuildModel.create({
        bot_id: normalizeBotId(botId),
        guild_id: makeGuildId(botId, name),
        name: String(name || '').trim(),
        owner_jid: normalizedOwner,
        officers: [],
        members: [normalizedOwner],
        bank: 0,
        level: 1,
        xp: 0,
        locale: String(locale || 'en').trim().toLowerCase() || 'en',
        created_at: Date.now(),
        updated_at: Date.now()
    });
    return guild.toObject ? guild.toObject() : guild;
}

async function getGuildById(guildId) {
    return GuildModel.findOne({ guild_id: String(guildId || '').trim() }).lean();
}

async function addGuildMember({ guildId, memberJid } = {}) {
    const normalizedMember = normalizePlayerJid(memberJid);
    await GuildModel.updateOne(
        { guild_id: String(guildId || '').trim() },
        {
            $addToSet: { members: normalizedMember },
            $set: { updated_at: Date.now() }
        }
    );
    return getGuildById(guildId);
}

module.exports = {
    createGuild,
    getGuildById,
    addGuildMember
};
