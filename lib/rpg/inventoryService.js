const {
    getRegisteredProfile,
    addInventoryItem,
    consumeInventoryItem
} = require('../registrationStore');

function getInventory(jid) {
    const profile = getRegisteredProfile(jid);
    return profile?.inventory && typeof profile.inventory === 'object' ? { ...profile.inventory } : {};
}

function getItemAmount(jid, itemKey) {
    const inventory = getInventory(jid);
    return Math.max(0, Number(inventory?.[itemKey] || 0));
}

function grantItem(jid, itemKey, amount = 1) {
    addInventoryItem(jid, itemKey, Math.max(1, Math.floor(Number(amount || 1))));
    return getItemAmount(jid, itemKey);
}

function spendItem(jid, itemKey, amount = 1) {
    return consumeInventoryItem(jid, itemKey, Math.max(1, Math.floor(Number(amount || 1))));
}

module.exports = {
    getInventory,
    getItemAmount,
    grantItem,
    spendItem
};
