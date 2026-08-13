function normalizePhone(value) {
    return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function normalizeJid(value) {
    const phone = normalizePhone(value);
    return phone ? `${phone}@s.whatsapp.net` : '';
}

function normalizeBotId(value) {
    return String(value || 'eclipse').trim().toLowerCase() || 'eclipse';
}

function normalizePlayerJid(value) {
    return normalizeJid(value) || String(value || '').trim();
}

module.exports = {
    normalizePhone,
    normalizeJid,
    normalizeBotId,
    normalizePlayerJid
};
