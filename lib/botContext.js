const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function runWithBotContext(context, fn) {
    return storage.run(context || {}, fn);
}

function getBotContext() {
    return storage.getStore() || {};
}

function getCurrentBot() {
    return getBotContext().bot || null;
}

function getCurrentProfile() {
    return getBotContext().profile || null;
}

module.exports = {
    runWithBotContext,
    getBotContext,
    getCurrentBot,
    getCurrentProfile
};
