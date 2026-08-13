const NETWORKS = {
    Wistoria: {
        key: 'Wistoria',
        label: 'Wistoria',
        risk: '0%',
        description: 'Stable. Reliable. Boring... but safe.',
        depositBonusRate: 0,
        withdrawDelayMs: 0,
        depositCooldownMs: 0,
        maxLimit: 25000,
        cardRequired: 'starter'
    },
    Neon: {
        key: 'Neon',
        label: 'Neon',
        risk: 'low',
        description: 'Fast money. Quick flips.',
        depositBonusRate: 0.02,
        withdrawDelayMs: 0,
        depositCooldownMs: 0,
        maxLimit: 8000,
        cardRequired: 'starter',
        spamPenaltyAfter: 5,
        spamPenaltyRate: 0.01,
        spamWindowMs: 60_000
    },
    Vortex: {
        key: 'Vortex',
        label: 'Vortex',
        risk: 'high',
        description: 'High risk. High dopamine.',
        depositBonusRate: 0,
        withdrawDelayMs: 0,
        depositCooldownMs: 0,
        maxLimit: 50000,
        cardRequired: 'silver',
        vortexWinRate: 0.6,
        vortexWinBonusRate: 0.2,
        vortexLossRate: 0.1,
        vortexBonusCap: 500
    },
    Titan: {
        key: 'Titan',
        label: 'Titan',
        risk: '0%',
        description: 'Cold storage. Big players only.',
        depositBonusRate: 0,
        withdrawDelayMs: 30_000,
        depositCooldownMs: 10_000,
        maxLimit: 250000,
        cardRequired: 'gold'
    },
    Glitch: {
        key: 'Glitch',
        label: 'Glitch',
        risk: 'chaos',
        description: 'System is unstable...',
        depositBonusRate: 0,
        withdrawDelayMs: 0,
        depositCooldownMs: 0,
        maxLimit: Number.MAX_SAFE_INTEGER,
        cardRequired: 'black',
        locked: true
    }
};

const CARD_ORDER = ['starter', 'silver', 'gold', 'black'];
const SWITCH_COOLDOWN_MS = 30_000;
const SWITCH_BLOCK_AFTER_DEPOSIT_MS = 10_000;
const CARD_SWITCH_DISCOUNT = {
    starter: 0,
    silver: 0.1,
    gold: 0.2,
    black: 1
};
const SWITCH_COSTS = {
    'Wistoria->Neon': 0,
    'Wistoria->Vortex': 400_000,
    'Wistoria->Titan': 500_000,
    'Neon->Vortex': 200_000,
    'Neon->Titan': 450_000,
    'Vortex->Titan': 200_000
};

function normalizeNetwork(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return 'Wistoria';
    if (text === 'eclipse') return 'Wistoria'; // FIXED: legacy Eclipse alias maps to Wistoria
    const found = Object.values(NETWORKS).find((n) => n.key.toLowerCase() === text);
    return found ? found.key : null;
}

function cardLevel(card) {
    const idx = CARD_ORDER.indexOf(String(card || '').toLowerCase());
    return idx >= 0 ? idx : 0;
}

function canAccessNetwork(card, network, opts = {}) {
    const info = NETWORKS[network];
    if (!info) return false;
    const unlockedNetworks = Array.isArray(opts.unlockedNetworks) ? opts.unlockedNetworks : [];
    if (unlockedNetworks.includes(info.key)) return true;
    return cardLevel(card) >= cardLevel(info.cardRequired);
}

function availableNetworksForCard(card, opts = {}) {
    const { glitchUnlocked = false } = opts;
    return Object.values(NETWORKS)
        .filter((network) => {
            if (network.key === 'Glitch' && !glitchUnlocked) return false;
            return canAccessNetwork(card, network.key, opts);
        })
        .map((network) => network.key);
}

function getSwitchBaseCost(fromNetwork, toNetwork) {
    const from = normalizeNetwork(fromNetwork);
    const to = normalizeNetwork(toNetwork);
    if (!from || !to) return null;
    if (from === to) return 0;
    if (to === 'Wistoria') return 50_000;
    const key = `${from}->${to}`;
    return Object.prototype.hasOwnProperty.call(SWITCH_COSTS, key) ? SWITCH_COSTS[key] : null;
}

function getCardSwitchDiscount(card) {
    return CARD_SWITCH_DISCOUNT[String(card || 'starter').toLowerCase()] || 0;
}

module.exports = {
    NETWORKS,
    SWITCH_COOLDOWN_MS,
    SWITCH_BLOCK_AFTER_DEPOSIT_MS,
    normalizeNetwork,
    canAccessNetwork,
    availableNetworksForCard,
    getSwitchBaseCost,
    getCardSwitchDiscount
};
