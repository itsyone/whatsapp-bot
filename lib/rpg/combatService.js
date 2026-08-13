function clampPositive(value) {
    return Math.max(0, Math.floor(Number(value || 0)));
}

function resolvePvECombat({
    playerAttack = 10,
    playerDefense = 0,
    enemyAttack = 8,
    enemyDefense = 0,
    enemyHealth = 50
} = {}) {
    const outgoing = Math.max(1, clampPositive(playerAttack) - clampPositive(enemyDefense));
    const incoming = Math.max(0, clampPositive(enemyAttack) - clampPositive(playerDefense));
    const turnsToWin = Math.max(1, Math.ceil(clampPositive(enemyHealth) / outgoing));
    const totalDamageTaken = incoming * Math.max(0, turnsToWin - 1);

    return {
        outgoingDamage: outgoing,
        incomingDamage: incoming,
        turnsToWin,
        totalDamageTaken,
        victory: true
    };
}

function scaleReward(baseReward = 0, level = 1, multiplier = 1) {
    const scaled = clampPositive(baseReward) + Math.max(0, Math.floor((Math.max(1, Number(level || 1)) - 1) * 3));
    return Math.max(0, Math.floor(scaled * Math.max(0, Number(multiplier || 1))));
}

module.exports = {
    resolvePvECombat,
    scaleReward
};
