let baileysPromise = null;

function getBaileys() {
    if (!baileysPromise) {
        baileysPromise = import('@itsliaaa/baileys');
    }
    return baileysPromise;
}

async function downloadContentFromMessage(...args) {
    const mod = await getBaileys();
    return mod.downloadContentFromMessage(...args);
}

async function downloadMediaMessage(...args) {
    const mod = await getBaileys();
    return mod.downloadMediaMessage(...args);
}

function isJidGroup(jid) {
    return typeof jid === 'string' && jid.endsWith('@g.us');
}

module.exports = {
    getBaileys,
    downloadContentFromMessage,
    downloadMediaMessage,
    isJidGroup,
};
