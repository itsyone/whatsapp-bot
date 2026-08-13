const { EconomyData, isMongoConnected } = require('../../lib/mongoStore');
const { WalletModel, EconomyLedgerModel } = require('../../lib/rpg/models');

function countUsersFromPayload(payload) {
    try {
        const parsed = JSON.parse(payload || '{}');
        return Object.keys(parsed.users || {}).length;
    } catch {
        return 0;
    }
}

async function getDocCount(botId) {
    const doc = await EconomyData.findOne({ bot_id: botId }).lean().catch(() => null);
    return {
        found: Boolean(doc),
        updatedAt: Number(doc?.updated_at || 0),
        users: countUsersFromPayload(doc?.payload || '{}')
    };
}

module.exports = {
    name: 'econhealth',
    aliases: ['economyhealth', 'balhealth'],
    permissionLevel: 'owner',
    async execute(ctx) {
        const { sock, chatId, message } = ctx;

        const [shared, eclipse, reze, walletDocs, ledgerDocs] = await Promise.all([
            getDocCount('__shared__'),
            getDocCount('eclipse'),
            getDocCount('reze'),
            WalletModel.countDocuments({}).catch(() => 0),
            EconomyLedgerModel.countDocuments({}).catch(() => 0)
        ]);

        const text = [
            'Economy Health',
            `Mongo: ${isMongoConnected() ? 'connected' : 'disconnected'}`,
            '',
            `Shared doc: ${shared.found ? 'yes' : 'no'} | users=${shared.users}`,
            `Eclipse doc: ${eclipse.found ? 'yes' : 'no'} | users=${eclipse.users}`,
            `Reze doc: ${reze.found ? 'yes' : 'no'} | users=${reze.users}`,
            '',
            `Wallet docs: ${Number(walletDocs || 0).toLocaleString()}`,
            `Ledger docs: ${Number(ledgerDocs || 0).toLocaleString()}`,
            '',
            `Shared updated: ${shared.updatedAt ? new Date(shared.updatedAt).toISOString() : 'n/a'}`,
            `Eclipse updated: ${eclipse.updatedAt ? new Date(eclipse.updatedAt).toISOString() : 'n/a'}`,
            `Reze updated: ${reze.updatedAt ? new Date(reze.updatedAt).toISOString() : 'n/a'}`
        ].join('\n');

        await sock.sendMessage(chatId, { text }, { quoted: message });
    }
};
