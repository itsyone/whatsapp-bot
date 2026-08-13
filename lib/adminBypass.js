const isOwnerOrSudo = require('./isOwner');
const { hasStaffRole } = require('./staffRoles');

async function hasAdminBypass(message, senderId) {
    if (message?.key?.fromMe) return true;
    if (hasStaffRole(senderId, ['mods'])) return true;
    return Boolean(await isOwnerOrSudo(senderId).catch(() => false));
}

module.exports = {
    hasAdminBypass
};
