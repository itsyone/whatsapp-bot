const fs = require('fs');
const path = require('path');

const MONSTER_FILE = path.join(__dirname, '..', 'data', 'monsters_final.json');

function pickTier() {
    const rand = Math.random() * 100;
    if (rand < 60) return 'Common';
    if (rand < 85) return 'Rare';
    if (rand < 95) return 'Epic';
    if (rand < 99) return 'Legendary';
    return 'Mythic';
}

function loadData() {
    if (!fs.existsSync(MONSTER_FILE)) return { cards: [], monsters: [] };
    try {
        const data = JSON.parse(fs.readFileSync(MONSTER_FILE, 'utf8'));
        if (Array.isArray(data)) {
            // legacy format fallback
            return { cards: data, monsters: [] };
        }
        return {
            cards: Array.isArray(data.cards) ? data.cards : [],
            monsters: Array.isArray(data.monsters) ? data.monsters : []
        };
    } catch {
        return { cards: [], monsters: [] };
    }
}

function roll(poolType = 'cards') {
    const data = loadData();
    const list = poolType === 'monsters' ? data.monsters : data.cards;
    if (!list.length) return null;

    const tier = pickTier();
    const pool = list.filter((x) => x.tier === tier);
    const source = pool.length ? pool : list;
    const drop = source[Math.floor(Math.random() * source.length)];

    return {
        ...drop,
        tier: drop.tier || tier,
        poolType
    };
}

module.exports = { roll };
