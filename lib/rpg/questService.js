const { getBotId } = require('../botDataPath');
const { ensureMongoReady } = require('../mongoStore');
const { QuestProgressModel } = require('./models');
const { normalizeBotId, normalizePlayerJid } = require('./identity');

async function startQuest({ botId = getBotId(), jid, questId, progress = {} } = {}) {
    await ensureMongoReady(botId).catch(() => false);
    const now = Date.now();
    await QuestProgressModel.updateOne(
        {
            bot_id: normalizeBotId(botId),
            jid: normalizePlayerJid(jid),
            quest_id: String(questId || '').trim()
        },
        {
            $set: {
                status: 'active',
                progress: progress && typeof progress === 'object' ? progress : {},
                updated_at: now
            },
            $setOnInsert: {
                bot_id: normalizeBotId(botId),
                jid: normalizePlayerJid(jid),
                quest_id: String(questId || '').trim(),
                rewards_claimed: false,
                started_at: now
            }
        },
        { upsert: true }
    );
    return getQuestProgress({ botId, jid, questId });
}

async function getQuestProgress({ botId = getBotId(), jid, questId } = {}) {
    return QuestProgressModel.findOne({
        bot_id: normalizeBotId(botId),
        jid: normalizePlayerJid(jid),
        quest_id: String(questId || '').trim()
    }).lean();
}

async function updateQuestProgress({ botId = getBotId(), jid, questId, progress = {}, status = '' } = {}) {
    await ensureMongoReady(botId).catch(() => false);
    const update = {
        progress: progress && typeof progress === 'object' ? progress : {},
        updated_at: Date.now()
    };
    if (status) update.status = String(status).trim();
    await QuestProgressModel.updateOne(
        {
            bot_id: normalizeBotId(botId),
            jid: normalizePlayerJid(jid),
            quest_id: String(questId || '').trim()
        },
        { $set: update }
    );
    return getQuestProgress({ botId, jid, questId });
}

module.exports = {
    startQuest,
    getQuestProgress,
    updateQuestProgress
};
