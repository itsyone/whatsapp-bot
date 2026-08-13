const { addWelcome, delWelcome, isWelcomeOn, addGoodbye, delGoodBye, isGoodByeOn } = require('../lib/index');

const RANDOM_WELCOME_TOKEN = '__RANDOM_WELCOME__';
const RANDOM_GOODBYE_TOKEN = '__RANDOM_GOODBYE__';
const pendingWelcomeSetups = new Map();

function getSetupKey(chatId, senderId) {
    return `${String(chatId || '').trim()}::${String(senderId || '').trim()}`;
}

async function handleWelcome(sock, chatId, message, match) {
    if (!match) {
        return sock.sendMessage(chatId, {
            text: 'Welcome setup:\n\n.welcome on\n.welcome random\n.welcome set Welcome {user} to {group}!\n.welcome off\n\nPlaceholders: @mention, {user}, {group}, {description}, {count}, {pfp}, {groupp}',
            quoted: message
        });
    }

    const rawMatch = String(match || '').trim();
    const commandMatch = rawMatch.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    const command = commandMatch?.[1] || '';
    const lowerCommand = String(command || '').toLowerCase();
    const customMessage = String(commandMatch?.[2] || '').trim();

    if (lowerCommand === 'on') {
        if (await isWelcomeOn(chatId)) {
            return sock.sendMessage(chatId, { text: 'Welcome messages are already enabled.', quoted: message });
        }
        await addWelcome(chatId, true, RANDOM_WELCOME_TOKEN);
        return sock.sendMessage(chatId, { text: 'Welcome enabled. Use `.welcome set ...` to customize it.', quoted: message });
    }

    if (lowerCommand === 'random') {
        await addWelcome(chatId, true, RANDOM_WELCOME_TOKEN);
        return sock.sendMessage(chatId, { text: 'Welcome random mode enabled.', quoted: message });
    }

    if (lowerCommand === 'off') {
        if (!(await isWelcomeOn(chatId))) {
            return sock.sendMessage(chatId, { text: 'Welcome messages are already disabled.', quoted: message });
        }
        await delWelcome(chatId);
        return sock.sendMessage(chatId, { text: 'Welcome messages disabled for this group.', quoted: message });
    }

    if (lowerCommand === 'set') {
        if (!customMessage) {
            pendingWelcomeSetups.set(getSetupKey(chatId, message?.key?.participant || message?.key?.remoteJid), true); // FIXED: welcome setup waits for next message
            return sock.sendMessage(chatId, { text: 'Send the welcome message in your next message.\nUse `cancel` to stop.\nPlaceholders: @mention, {user}, {group}, {description}, {count}', quoted: message });
        }
        await addWelcome(chatId, true, customMessage);
        return sock.sendMessage(chatId, { text: 'Welcome message saved.\nYou can use `@mention`, `{user}`, `{group}`, `{description}`, `{count}`, `{pfp}`, `{groupp}`.', quoted: message });
    }

    return sock.sendMessage(chatId, {
        text: 'Invalid welcome command.\nUse `.welcome on`, `.welcome set <message>`, or `.welcome off`.',
        quoted: message
    });
}

async function handleWelcomeSetupReply(sock, chatId, message, senderId, rawText) {
    const key = getSetupKey(chatId, senderId);
    if (!pendingWelcomeSetups.has(key)) {
        return false;
    }

    const text = String(rawText || '').trim();
    if (!text) {
        return true;
    }

    if (/^cancel$/i.test(text)) {
        pendingWelcomeSetups.delete(key);
        await sock.sendMessage(chatId, { text: 'Welcome setup cancelled.' }, { quoted: message });
        return true;
    }

    pendingWelcomeSetups.delete(key);
    await addWelcome(chatId, true, text); // FIXED: save exact next-message welcome template
    await sock.sendMessage(chatId, { text: 'Welcome message saved.\nYou can use `@mention`, `{user}`, `{group}`, `{description}`, `{count}`.' }, { quoted: message });
    return true;
}

async function handleGoodbye(sock, chatId, message, match) {
    if (!match) {
        return sock.sendMessage(chatId, {
            text: 'Goodbye setup:\n\n.goodbye on\n.goodbye random\n.goodbye set Bye {user}\n.goodbye off\n\nPlaceholders: @mention, {user}, {group}, {description}, {count}, {pfp}, {groupp}',
            quoted: message
        });
    }

    const rawMatch = String(match || '').trim();
    const commandMatch = rawMatch.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    const command = commandMatch?.[1] || '';
    const lowerCommand = String(command || '').toLowerCase();
    const customMessage = String(commandMatch?.[2] || '').trim();

    if (lowerCommand === 'on') {
        if (await isGoodByeOn(chatId)) {
            return sock.sendMessage(chatId, { text: 'Goodbye messages are already enabled.', quoted: message });
        }
        await addGoodbye(chatId, true, RANDOM_GOODBYE_TOKEN);
        return sock.sendMessage(chatId, { text: 'Goodbye enabled. Use `.goodbye set ...` to customize it.', quoted: message });
    }

    if (lowerCommand === 'random') {
        await addGoodbye(chatId, true, RANDOM_GOODBYE_TOKEN);
        return sock.sendMessage(chatId, { text: 'Goodbye random mode enabled.', quoted: message });
    }

    if (lowerCommand === 'off') {
        if (!(await isGoodByeOn(chatId))) {
            return sock.sendMessage(chatId, { text: 'Goodbye messages are already disabled.', quoted: message });
        }
        await delGoodBye(chatId);
        return sock.sendMessage(chatId, { text: 'Goodbye messages disabled for this group.', quoted: message });
    }

    if (lowerCommand === 'set') {
        if (!customMessage) {
            return sock.sendMessage(chatId, { text: 'Please provide a goodbye message.\nExample: `.goodbye set Bye {user}`', quoted: message });
        }
        await addGoodbye(chatId, true, customMessage);
        return sock.sendMessage(chatId, { text: 'Goodbye message saved.\nYou can use `@mention`, `{user}`, `{group}`, `{description}`, `{count}`, `{pfp}`, `{groupp}`.', quoted: message });
    }

    return sock.sendMessage(chatId, {
        text: 'Invalid goodbye command.\nUse `.goodbye on`, `.goodbye set <message>`, or `.goodbye off`.',
        quoted: message
    });
}

module.exports = { handleWelcome, handleGoodbye, handleWelcomeSetupReply, RANDOM_WELCOME_TOKEN, RANDOM_GOODBYE_TOKEN };
