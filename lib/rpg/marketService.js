const { getBotId } = require('../botDataPath');
const { ensureMongoReady } = require('../mongoStore');
const { MarketListingModel } = require('./models');
const { normalizeBotId, normalizePlayerJid } = require('./identity');

function makeListingId(botId, sellerJid, itemKey) {
    return `${normalizeBotId(botId)}:market:${normalizePlayerJid(sellerJid)}:${String(itemKey || '').trim()}:${Date.now()}`;
}

async function createListing({
    botId = getBotId(),
    sellerJid,
    itemKey,
    itemName = '',
    quantity = 1,
    unitPrice,
    currency = 'wallet',
    meta = {}
} = {}) {
    await ensureMongoReady(botId).catch(() => false);
    const listing = await MarketListingModel.create({
        bot_id: normalizeBotId(botId),
        listing_id: makeListingId(botId, sellerJid, itemKey),
        seller_jid: normalizePlayerJid(sellerJid),
        item_key: String(itemKey || '').trim(),
        item_name: String(itemName || '').trim(),
        quantity: Math.max(1, Math.floor(Number(quantity || 1))),
        unit_price: Math.max(0, Math.floor(Number(unitPrice || 0))),
        currency: String(currency || 'wallet').trim(),
        status: 'active',
        meta: meta && typeof meta === 'object' ? meta : {},
        created_at: Date.now(),
        updated_at: Date.now()
    });
    return listing.toObject ? listing.toObject() : listing;
}

async function listActiveListings({ botId = getBotId(), itemKey = '', limit = 20 } = {}) {
    const filter = { bot_id: normalizeBotId(botId), status: 'active' };
    if (itemKey) filter.item_key = String(itemKey || '').trim();
    return MarketListingModel.find(filter)
        .sort({ unit_price: 1, created_at: -1 })
        .limit(Math.max(1, Math.min(100, Number(limit || 20))))
        .lean();
}

async function closeListing({ listingId, status = 'closed' } = {}) {
    await MarketListingModel.updateOne(
        { listing_id: String(listingId || '').trim() },
        { $set: { status: String(status || 'closed'), updated_at: Date.now() } }
    );
    return MarketListingModel.findOne({ listing_id: String(listingId || '').trim() }).lean();
}

module.exports = {
    createListing,
    listActiveListings,
    closeListing
};
