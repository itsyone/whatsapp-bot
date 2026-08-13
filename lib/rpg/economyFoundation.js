const crypto = require('crypto');
const { getBotId } = require('../botDataPath');
const { ensureMongoReady } = require('../mongoStore');
const { WalletModel, EconomyLedgerModel } = require('./models');
const { normalizeBotId, normalizePlayerJid } = require('./identity');
const { logAdminAction } = require('./auditService');

function makeTxId(prefix = 'tx') {
    return `${prefix}:${Date.now()}:${crypto.randomBytes(6).toString('hex')}`;
}

async function ensureFoundationReady(botId = getBotId()) {
    await ensureMongoReady(botId).catch(() => false);
}

function ensureBanks(banks = {}) {
    return {
        Wistoria: Math.max(0, Number((banks?.Wistoria ?? banks?.Eclipse) || 0)),
        Neon: Math.max(0, Number(banks?.Neon || 0)),
        Vortex: Math.max(0, Number(banks?.Vortex || 0)),
        Titan: Math.max(0, Number(banks?.Titan || 0)),
        Glitch: Math.max(0, Number(banks?.Glitch || 0))
    };
}

function ensureTxMeta(meta = {}) {
    return {
        System: {
            lastDepositAt: Number(meta?.System?.lastDepositAt || 0),
            lastSwitchAt: Number(meta?.System?.lastSwitchAt || 0)
        },
        Neon: {
            recentTransactions: Array.isArray(meta?.Neon?.recentTransactions)
                ? meta.Neon.recentTransactions.map(Number).filter(Boolean)
                : []
        },
        Titan: {
            lastDepositAt: Number(meta?.Titan?.lastDepositAt || 0),
            pendingWithdrawals: Array.isArray(meta?.Titan?.pendingWithdrawals)
                ? meta.Titan.pendingWithdrawals.map((entry) => ({
                    amount: Math.max(0, Number(entry?.amount || 0)),
                    createdAt: Math.max(0, Number(entry?.createdAt || 0)),
                    readyAt: Math.max(0, Number(entry?.readyAt || 0))
                }))
                : []
        },
        Glitch: {
            phantomBalance: Math.max(0, Number(meta?.Glitch?.phantomBalance || 0))
        }
    };
}

async function ensureWallet(botId, jid) {
    await ensureFoundationReady(botId);
    const normalizedBotId = normalizeBotId(botId);
    const normalizedJid = normalizePlayerJid(jid);
    const now = Date.now();
    await WalletModel.updateOne(
        { bot_id: normalizedBotId, jid: normalizedJid },
        {
            $setOnInsert: {
                bot_id: normalizedBotId,
                jid: normalizedJid,
                wallet: 0,
                activeNetwork: 'Wistoria',
                banks: ensureBanks(),
                txMeta: ensureTxMeta(),
                version: 0,
                lastLedgerAt: 0,
                lastSource: 'bootstrap',
                created_at: now,
                updated_at: now
            }
        },
        { upsert: true }
    );
    return WalletModel.findOne({ bot_id: normalizedBotId, jid: normalizedJid }).lean();
}

async function getWallet(botId = getBotId(), jid) {
    const doc = await ensureWallet(botId, jid);
    return {
        botId: normalizeBotId(botId),
        jid: normalizePlayerJid(jid),
        wallet: Math.max(0, Number(doc?.wallet || 0)),
        activeNetwork: String(doc?.activeNetwork || 'Wistoria').replace(/^Eclipse$/i, 'Wistoria'),
        banks: ensureBanks(doc?.banks || {}),
        txMeta: ensureTxMeta(doc?.txMeta || {}),
        version: Number(doc?.version || 0),
        updatedAt: Number(doc?.updated_at || 0)
    };
}

async function mirrorWalletState({
    botId = getBotId(),
    jid,
    wallet = 0,
    activeNetwork = 'Wistoria',
    banks = {},
    txMeta = {},
    source = 'legacy_snapshot'
} = {}) {
    await ensureFoundationReady(botId);
    const normalizedBotId = normalizeBotId(botId);
    const normalizedJid = normalizePlayerJid(jid);
    if (!normalizedJid) return false;

    const now = Date.now();
    try {
        const existing = await WalletModel.findOne({ bot_id: normalizedBotId, jid: normalizedJid }).lean();
        const nextBanks = ensureBanks(banks);
        const sourceKey = String(source || 'legacy_snapshot');
        const bankShrinkAllowed = new Set([
            'withdraw_from_bank',
            'withdraw_pending',
            'ledger_restore',
            'ledger_bank_reconcile',
            'ledger_full_reconcile'
        ]);
        if (existing && !bankShrinkAllowed.has(sourceKey)) {
            const existingBanks = ensureBanks(existing.banks || {});
            for (const network of Object.keys(existingBanks)) {
                nextBanks[network] = Math.max(nextBanks[network] || 0, existingBanks[network] || 0);
            }
        }

        let nextWallet = Math.max(0, Number(wallet || 0));
        const passiveSources = new Set([
            'process_message_activity',
            'process_chat_reward',
            'get_missions',
            'progress_mission',
            'set_active_network',
            'ledger_bank_reconcile'
        ]);
        if (existing && passiveSources.has(sourceKey)) {
            nextWallet = Math.max(nextWallet, Math.max(0, Number(existing.wallet || 0)));
        }

        await WalletModel.updateOne(
            { bot_id: normalizedBotId, jid: normalizedJid },
            {
                $set: {
                    wallet: nextWallet,
                    activeNetwork: String(activeNetwork || 'Wistoria').replace(/^Eclipse$/i, 'Wistoria'),
                    banks: nextBanks,
                    txMeta: ensureTxMeta(txMeta),
                    lastSource: sourceKey,
                    updated_at: now
                },
                $setOnInsert: {
                    bot_id: normalizedBotId,
                    jid: normalizedJid,
                    created_at: now,
                    version: 0,
                    lastLedgerAt: 0
                }
            },
            { upsert: true }
        );
        return true;
    } catch (error) {
        console.error('[economyFoundation] mirrorWalletState failed:', error?.message || error);
        return false;
    }
}

async function recordLedgerEntry({
    botId = getBotId(),
    jid,
    delta = 0,
    before = 0,
    after = 0,
    actorJid = '',
    source = 'unknown',
    category = 'economy',
    meta = {},
    reversible = true,
    txId
} = {}) {
    await ensureFoundationReady(botId);
    const normalizedBotId = normalizeBotId(botId);
    const normalizedJid = normalizePlayerJid(jid);
    const normalizedActor = normalizePlayerJid(actorJid);
    const effectiveTxId = String(txId || makeTxId(source)).trim();
    if (!normalizedJid || !effectiveTxId) return { ok: false, reason: 'invalid_input' };

    const existing = await EconomyLedgerModel.findOne({ tx_id: effectiveTxId }).lean();
    if (existing) {
        return { ok: true, duplicate: true, ledger: existing };
    }

    const now = Date.now();
    try {
        const created = await EconomyLedgerModel.create({
            bot_id: normalizedBotId,
            tx_id: effectiveTxId,
            jid: normalizedJid,
            actor_jid: normalizedActor,
            source: String(source || 'unknown'),
            category: String(category || 'economy'),
            delta: Number(delta || 0),
            before: Math.max(0, Number(before || 0)),
            after: Math.max(0, Number(after || 0)),
            status: 'applied',
            reversible: reversible !== false,
            meta: meta && typeof meta === 'object' ? meta : { value: meta },
            created_at: now,
            updated_at: now
        });
        await WalletModel.updateOne(
            { bot_id: normalizedBotId, jid: normalizedJid },
            { $set: { lastLedgerAt: now, updated_at: now } }
        );
        return { ok: true, ledger: created.toObject ? created.toObject() : created };
    } catch (error) {
        if (error?.code === 11000) {
            const duplicate = await EconomyLedgerModel.findOne({ tx_id: effectiveTxId }).lean();
            return { ok: true, duplicate: true, ledger: duplicate };
        }
        console.error('[economyFoundation] recordLedgerEntry failed:', error?.message || error);
        return { ok: false, reason: 'ledger_write_failed' };
    }
}

async function listLedgerEntries({
    botId = getBotId(),
    jid = '',
    limit = 10,
    source = ''
} = {}) {
    await ensureFoundationReady(botId);
    const filter = { bot_id: normalizeBotId(botId) };
    if (jid) filter.jid = normalizePlayerJid(jid);
    if (source) filter.source = String(source || '');
    return EconomyLedgerModel.find(filter)
        .sort({ created_at: -1 })
        .limit(Math.max(1, Math.min(50, Number(limit || 10))))
        .lean();
}

async function restoreLedgerEntry({
    botId = getBotId(),
    txId,
    actorJid = '',
    reason = 'manual_restore'
} = {}) {
    await ensureFoundationReady(botId);
    const original = await EconomyLedgerModel.findOne({ tx_id: String(txId || '').trim() });
    if (!original) {
        return { ok: false, reason: 'not_found' };
    }
    if (original.reversible === false) {
        return { ok: false, reason: 'not_reversible' };
    }
    if (original.reversed_by) {
        return { ok: false, reason: 'already_reversed', reversedBy: original.reversed_by };
    }

    const wallet = await getWallet(botId, original.jid);
    const reverseDelta = Number(original.delta || 0) * -1;
    const nextWallet = wallet.wallet + reverseDelta;
    if (nextWallet < 0) {
        return { ok: false, reason: 'insufficient_wallet', wallet: wallet.wallet };
    }

    const normalizedBotId = normalizeBotId(botId);
    const normalizedActor = normalizePlayerJid(actorJid);
    const reverseTxId = makeTxId(`restore:${original.tx_id}`);
    const now = Date.now();

    const walletUpdate = await WalletModel.updateOne(
        { bot_id: normalizedBotId, jid: wallet.jid, wallet: wallet.wallet },
        {
            $set: {
                wallet: nextWallet,
                updated_at: now,
                lastSource: 'ledger_restore'
            },
            $inc: { version: 1 }
        }
    );
    if (!walletUpdate.modifiedCount) {
        return { ok: false, reason: 'wallet_conflict' };
    }

    const ledgerResult = await recordLedgerEntry({
        botId: normalizedBotId,
        jid: wallet.jid,
        delta: reverseDelta,
        before: wallet.wallet,
        after: nextWallet,
        actorJid: normalizedActor,
        source: 'restoretx',
        category: 'admin_restore',
        meta: {
            original_tx_id: original.tx_id,
            original_source: original.source,
            reason
        },
        txId: reverseTxId,
        reversible: false
    });

    if (!ledgerResult.ok) {
        return { ok: false, reason: 'ledger_write_failed_after_restore' };
    }

    original.reversed_by = reverseTxId;
    original.updated_at = now;
    await original.save();
    await logAdminAction({
        botId: normalizedBotId,
        action: 'restoretx',
        actorJid: normalizedActor,
        targetJid: wallet.jid,
        details: {
            original_tx_id: original.tx_id,
            reverse_tx_id: reverseTxId,
            reverse_delta: reverseDelta,
            reason
        }
    });

    return {
        ok: true,
        reverseTxId,
        balance: nextWallet,
        originalTxId: original.tx_id
    };
}

async function backfillLegacyEconomy(botId = getBotId(), db = {}) {
    await ensureFoundationReady(botId);
    const normalizedBotId = normalizeBotId(botId);
    const users = db?.users && typeof db.users === 'object' ? db.users : {};
    const tasks = Object.entries(users).map(([jid, user]) => (
        mirrorWalletState({
            botId: normalizedBotId,
            jid,
            wallet: Number(user?.wallet || user?.balance || 0),
        activeNetwork: String(user?.activeNetwork || 'Wistoria').replace(/^Eclipse$/i, 'Wistoria'),
            banks: user?.banks || {},
            txMeta: user?.txMeta || {},
            source: 'legacy_backfill'
        })
    ));
    await Promise.allSettled(tasks);
}

module.exports = {
    makeTxId,
    ensureWallet,
    getWallet,
    mirrorWalletState,
    recordLedgerEntry,
    listLedgerEntries,
    restoreLedgerEntry,
    backfillLegacyEconomy
};
