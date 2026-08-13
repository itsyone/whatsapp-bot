const { PERMISSION_LEVELS, hasPermission } = require('../../lib/permissionMiddleware');
const { setSession, getSession, deleteSession } = require('../../lib/sessionManager');
const { getBalance, setBalance } = require('../../lib/economy');

const MODTEST_SESSION_PREFIX = 'modtest:';

/**
 * Enable modtest mode for a user
 * Stores original balance and enables test mode
 */
async function enableModtest(sock, chatId, message, senderId) {
    try {
        const key = `${MODTEST_SESSION_PREFIX}${senderId}`;
        
        // Check if already in modtest mode
        const existing = getSession(key);
        if (existing) {
            await sock.sendMessage(chatId, { text: '❌ Modtest mode is already enabled.' }, { quoted: message });
            return;
        }
        
        // Get current balance
        const currentBalance = await getBalance(senderId);
        
        // Store original balance and enable modtest
        setSession(key, {
            enabled: true,
            originalBalance: currentBalance,
            enabledAt: Date.now()
        });
        
        await sock.sendMessage(chatId, { 
            text: `✅ *Modtest mode enabled*\n\nOriginal balance: ${currentBalance}\n\nYou can now test commands without restrictions. All test balance will be removed when you disable modtest mode.` 
        }, { quoted: message });
    } catch (error) {
        console.error('[Modtest] Error enabling modtest:', error);
        await sock.sendMessage(chatId, { text: `❌ Error: ${error.message}` }, { quoted: message });
    }
}

/**
 * Disable modtest mode for a user
 * Restores original balance and removes test balance
 */
async function disableModtest(sock, chatId, message, senderId) {
    try {
        const key = `${MODTEST_SESSION_PREFIX}${senderId}`;
        
        // Check if modtest mode is enabled
        const modtestData = getSession(key);
        if (!modtestData) {
            await sock.sendMessage(chatId, { text: '❌ Modtest mode is not enabled.' }, { quoted: message });
            return;
        }
        
        // Get current balance
        const currentBalance = await getBalance(senderId);
        const originalBalance = modtestData.originalBalance;
        const testBalance = currentBalance - originalBalance;
        
        // Restore original balance
        await setBalance(senderId, originalBalance);
        
        // Delete modtest session
        deleteSession(key);
        
        await sock.sendMessage(chatId, { 
            text: `✅ *Modtest mode disabled*\n\nOriginal balance restored: ${originalBalance}\nTest balance removed: ${testBalance}` 
        }, { quoted: message });
    } catch (error) {
        console.error('[Modtest] Error disabling modtest:', error);
        await sock.sendMessage(chatId, { text: `❌ Error: ${error.message}` }, { quoted: message });
    }
}

/**
 * Check if modtest mode is enabled for a user
 */
function isModtestEnabled(senderId) {
    const key = `${MODTEST_SESSION_PREFIX}${senderId}`;
    const modtestData = getSession(key);
    return Boolean(modtestData && modtestData.enabled);
}

/**
 * Get original balance for a user in modtest mode
 */
function getOriginalBalance(senderId) {
    const key = `${MODTEST_SESSION_PREFIX}${senderId}`;
    const modtestData = getSession(key);
    return modtestData ? modtestData.originalBalance : null;
}

/**
 * Main modtest command handler
 */
async function modtestCommand(sock, chatId, message, args) {
    // No permission check - allow anyone to use modtest
    const senderId = message?.key?.participant || message?.key?.remoteJid;

    const action = String(args || '').trim().toLowerCase();

    if (!action) {
        const enabled = isModtestEnabled(senderId);
        await sock.sendMessage(chatId, { 
            text: `*MODTEST MODE*\n\n.modtest add - Enable modtest mode\n.modtest off - Disable modtest mode\n\nStatus: ${enabled ? 'ON' : 'OFF'}` 
        }, { quoted: message });
        return;
    }

    if (action === 'add' || action === 'on' || action === 'enable') {
        await enableModtest(sock, chatId, message, senderId);
        return;
    }

    if (action === 'off' || action === 'disable' || action === 'remove') {
        await disableModtest(sock, chatId, message, senderId);
        return;
    }

    await sock.sendMessage(chatId, { 
        text: 'Usage: .modtest add (enable) or .modtest off (disable)' 
    }, { quoted: message });
}

module.exports = {
    modtestCommand,
    isModtestEnabled,
    getOriginalBalance
};
