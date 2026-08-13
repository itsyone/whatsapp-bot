const mongoose = require('mongoose');

const WalletSchema = new mongoose.Schema({
    bot_id: { type: String, required: true, index: true },
    jid: { type: String, required: true },
    wallet: { type: Number, default: 0 },
    activeNetwork: { type: String, default: 'Wistoria' },
    banks: { type: Map, of: Number, default: {} },
    txMeta: { type: mongoose.Schema.Types.Mixed, default: {} },
    version: { type: Number, default: 0 },
    lastLedgerAt: { type: Number, default: 0 },
    lastSource: { type: String, default: 'legacy' },
    created_at: { type: Number, required: true, default: () => Date.now() },
    updated_at: { type: Number, required: true, default: () => Date.now() }
}, { minimize: false, versionKey: false });
WalletSchema.index({ bot_id: 1, jid: 1 }, { unique: true });

const EconomyLedgerSchema = new mongoose.Schema({
    bot_id: { type: String, required: true, index: true },
    tx_id: { type: String, required: true, unique: true },
    jid: { type: String, required: true, index: true },
    actor_jid: { type: String, default: '' },
    source: { type: String, default: 'unknown', index: true },
    category: { type: String, default: 'economy', index: true },
    delta: { type: Number, required: true },
    before: { type: Number, required: true, default: 0 },
    after: { type: Number, required: true, default: 0 },
    status: { type: String, default: 'applied', index: true },
    reversible: { type: Boolean, default: true },
    reversed_by: { type: String, default: '' },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    created_at: { type: Number, required: true, default: () => Date.now() },
    updated_at: { type: Number, required: true, default: () => Date.now() }
}, { minimize: false, versionKey: false });
EconomyLedgerSchema.index({ bot_id: 1, jid: 1, created_at: -1 });

const AdminAuditLogSchema = new mongoose.Schema({
    bot_id: { type: String, required: true, index: true },
    action: { type: String, required: true, index: true },
    actor_jid: { type: String, default: '' },
    target_jid: { type: String, default: '' },
    status: { type: String, default: 'success', index: true },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    created_at: { type: Number, required: true, default: () => Date.now() }
}, { minimize: false, versionKey: false });
AdminAuditLogSchema.index({ bot_id: 1, action: 1, created_at: -1 });

const GuildSchema = new mongoose.Schema({
    bot_id: { type: String, required: true, index: true },
    guild_id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    owner_jid: { type: String, required: true },
    officers: { type: [String], default: [] },
    members: { type: [String], default: [] },
    bank: { type: Number, default: 0 },
    level: { type: Number, default: 1 },
    xp: { type: Number, default: 0 },
    locale: { type: String, default: 'en' },
    created_at: { type: Number, required: true, default: () => Date.now() },
    updated_at: { type: Number, required: true, default: () => Date.now() }
}, { minimize: false, versionKey: false });
GuildSchema.index({ bot_id: 1, owner_jid: 1 });

const QuestProgressSchema = new mongoose.Schema({
    bot_id: { type: String, required: true, index: true },
    jid: { type: String, required: true, index: true },
    quest_id: { type: String, required: true },
    status: { type: String, default: 'active', index: true },
    progress: { type: mongoose.Schema.Types.Mixed, default: {} },
    rewards_claimed: { type: Boolean, default: false },
    started_at: { type: Number, required: true, default: () => Date.now() },
    updated_at: { type: Number, required: true, default: () => Date.now() }
}, { minimize: false, versionKey: false });
QuestProgressSchema.index({ bot_id: 1, jid: 1, quest_id: 1 }, { unique: true });

const MarketListingSchema = new mongoose.Schema({
    bot_id: { type: String, required: true, index: true },
    listing_id: { type: String, required: true, unique: true },
    seller_jid: { type: String, required: true, index: true },
    item_key: { type: String, required: true, index: true },
    item_name: { type: String, default: '' },
    quantity: { type: Number, default: 1 },
    unit_price: { type: Number, required: true },
    currency: { type: String, default: 'wallet' },
    status: { type: String, default: 'active', index: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    created_at: { type: Number, required: true, default: () => Date.now() },
    updated_at: { type: Number, required: true, default: () => Date.now() }
}, { minimize: false, versionKey: false });
MarketListingSchema.index({ bot_id: 1, status: 1, item_key: 1, unit_price: 1 });

const LocalePreferenceSchema = new mongoose.Schema({
    bot_id: { type: String, required: true, index: true },
    jid: { type: String, required: true },
    locale: { type: String, required: true, default: 'en' },
    timezone: { type: String, default: 'UTC' },
    created_at: { type: Number, required: true, default: () => Date.now() },
    updated_at: { type: Number, required: true, default: () => Date.now() }
}, { minimize: false, versionKey: false });
LocalePreferenceSchema.index({ bot_id: 1, jid: 1 }, { unique: true });

module.exports = {
    WalletModel: mongoose.models.RpgWallet || mongoose.model('RpgWallet', WalletSchema),
    EconomyLedgerModel: mongoose.models.EconomyLedger || mongoose.model('EconomyLedger', EconomyLedgerSchema),
    AdminAuditLogModel: mongoose.models.AdminAuditLog || mongoose.model('AdminAuditLog', AdminAuditLogSchema),
    GuildModel: mongoose.models.RpgGuild || mongoose.model('RpgGuild', GuildSchema),
    QuestProgressModel: mongoose.models.RpgQuestProgress || mongoose.model('RpgQuestProgress', QuestProgressSchema),
    MarketListingModel: mongoose.models.RpgMarketListing || mongoose.model('RpgMarketListing', MarketListingSchema),
    LocalePreferenceModel: mongoose.models.LocalePreference || mongoose.model('LocalePreference', LocalePreferenceSchema)
};
