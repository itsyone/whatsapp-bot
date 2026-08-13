const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', 'data', 'sosRelay.json');

function ensureStore() {
    try {
        if (!fs.existsSync(path.dirname(STORE_PATH))) {
            fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
        }
        if (!fs.existsSync(STORE_PATH)) {
            const initial = { relayChatId: '' };
            fs.writeFileSync(STORE_PATH, JSON.stringify(initial, null, 2), 'utf8');
            return initial;
        }

        const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
        return {
            relayChatId: String(parsed?.relayChatId || '').trim()
        };
    } catch {
        return { relayChatId: '' };
    }
}

function saveStore(store) {
    const next = {
        relayChatId: String(store?.relayChatId || '').trim()
    };
    fs.writeFileSync(STORE_PATH, JSON.stringify(next, null, 2), 'utf8');
    return next;
}

function getSosRelayChatId() {
    return ensureStore().relayChatId;
}

function setSosRelayChatId(chatId) {
    const store = ensureStore();
    store.relayChatId = String(chatId || '').trim();
    return saveStore(store).relayChatId;
}

module.exports = {
    getSosRelayChatId,
    setSosRelayChatId
};
