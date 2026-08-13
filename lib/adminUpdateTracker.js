const updates = new Set();

function normalizeParticipant(value) {
    const text = typeof value === 'object' && value
        ? String(value.id || value.jid || value.participant || value.user || value.lid || value.pn || value.phoneNumber || '').trim()
        : String(value || '').trim();
    if (!text) return '';
    const local = text.split('@')[0].split(':')[0].replace(/[^\dA-Za-z_-]/g, '');
    return local || text;
}

function makeKey(chatId, action, participants = []) {
    return `${String(chatId || '').trim()}:${String(action || '').trim()}:${[...participants]
        .map(normalizeParticipant)
        .filter(Boolean)
        .sort()
        .join(',')}`;
}

function markAdminUpdate(chatId, action, participants = []) {
    updates.add(makeKey(chatId, action, participants));
}

function consumeAdminUpdate(chatId, action, participants = []) {
    const key = makeKey(chatId, action, participants);
    if (!updates.has(key)) return false;
    updates.delete(key);
    return true;
}

module.exports = {
    markAdminUpdate,
    consumeAdminUpdate
};
