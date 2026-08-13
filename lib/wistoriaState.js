const fs = require('fs');
const path = require('path');
const { getBotDataPath } = require('./botDataPath');

const STATE_PATH = getBotDataPath('wistoria.json');

function readState() {
    try {
        if (!fs.existsSync(STATE_PATH)) return { groups: {} };
        const data = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8') || '{}');
        if (!data.groups || typeof data.groups !== 'object') data.groups = {};
        return data;
    } catch {
        return { groups: {} };
    }
}

function writeState(state) {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function isWistoriaEnabled(chatId) {
    const state = readState();
    return state.groups[chatId] !== false;
}

function setWistoriaEnabled(chatId, enabled) {
    const state = readState();
    state.groups[chatId] = Boolean(enabled);
    writeState(state);
    return state.groups[chatId];
}

module.exports = {
    readState,
    writeState,
    isWistoriaEnabled,
    setWistoriaEnabled
};
