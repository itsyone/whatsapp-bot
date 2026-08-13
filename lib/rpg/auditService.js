const { getBotId } = require('../botDataPath');
const { ensureMongoReady } = require('../mongoStore');
const { AdminAuditLogModel } = require('./models');
const { normalizeBotId, normalizePlayerJid } = require('./identity');

async function logAdminAction({
    botId = getBotId(),
    action = 'unknown',
    actorJid = '',
    targetJid = '',
    status = 'success',
    details = {}
} = {}) {
    const now = Date.now();
    try {
        await ensureMongoReady(botId).catch(() => false);
        await AdminAuditLogModel.create({
            bot_id: normalizeBotId(botId),
            action: String(action || 'unknown'),
            actor_jid: normalizePlayerJid(actorJid),
            target_jid: normalizePlayerJid(targetJid),
            status: String(status || 'success'),
            details: details && typeof details === 'object' ? details : { value: details },
            created_at: now
        });
        return true;
    } catch (error) {
        console.error('[auditService] logAdminAction failed:', error?.message || error);
        return false;
    }
}

module.exports = {
    logAdminAction
};
