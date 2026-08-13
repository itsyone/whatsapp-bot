const { isOwner, isSudo } = require('./permissionHandler');
const { hasStaffRole } = require('./staffRoles');

async function isOwnerOrSudo(senderId) {
    if (!senderId) return false;

    try {
        if (hasStaffRole(senderId, ['mods'])) {
            return true;
        }
        if (await isOwner(senderId)) {
            return true;
        }
        return await isSudo(senderId); // FIXED: central sudo/owner resolution for legacy callers
    } catch (e) {
        return hasStaffRole(senderId, ['mods']);
    }
}

module.exports = isOwnerOrSudo;
