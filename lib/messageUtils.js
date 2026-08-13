const { downloadContentFromMessage } = require('./baileys');

async function sendReaction(sock, chatId, message, emoji) {
    try {
        if (!sock?.sendMessage || !chatId || !emoji || !message?.key) return;
        await sock.sendMessage(chatId, {
            react: { text: emoji, key: message.key }
        });
    } catch {}
}

async function messageContentToBuffer(messageContent, mediaType) {
    if (!messageContent) return null;
    const stream = await downloadContentFromMessage(messageContent, mediaType);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

function collectMessageNodes(node, bucket = []) {
    if (!node || typeof node !== 'object') return bucket;
    bucket.push(node);
    for (const value of Object.values(node)) {
        if (value && typeof value === 'object') {
            collectMessageNodes(value, bucket);
        }
    }
    return bucket;
}

async function getQuotedOrOwnImageBuffer(message) {
    const nodes = collectMessageNodes(message?.message || {});

    for (const node of nodes) {
        const quoted = node?.contextInfo?.quotedMessage;
        if (quoted?.imageMessage) {
            return messageContentToBuffer(quoted.imageMessage, 'image');
        }
    }

    for (const node of nodes) {
        if (node?.imageMessage) {
            return messageContentToBuffer(node.imageMessage, 'image');
        }
    }

    return null;
}

module.exports = {
    sendReaction,
    getQuotedOrOwnImageBuffer
};
