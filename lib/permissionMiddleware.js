const fs = require('fs');
const path = require('path');
const { getBotDataPath } = require('./botDataPath');
const settings = require('../settings');

/**
 * Load existing sudo list from userGroupData.json
 */
function loadExistingSudoList() {
    try {
        const userGroupDataPath = getBotDataPath('userGroupData.json');
        if (!fs.existsSync(userGroupDataPath)) {
            return [];
        }
        const data = fs.readFileSync(userGroupDataPath, 'utf8');
        const parsed = JSON.parse(data);
        return Array.isArray(parsed.sudo) ? parsed.sudo : [];
    } catch (error) {
        console.error('[PermissionMiddleware] Error loading existing sudo list:', error.message);
        return [];
    }
}

/**
 * Permission Middleware System
 * Handles user authorization and permission validation
 */

const PERMISSIONS_PATH = getBotDataPath('permissions.json');

// Permission levels
const PERMISSION_LEVELS = {
    OWNER: 'owner',
    MOD: 'mod',
    ADMIN: 'admin',
    USER: 'user'
};

// Default permission state
let permissionState = {
    owners: [],
    mods: [],
    groups: {} // { groupId: { admins: [] } }
};

/**
 * Load permissions from file
 */
function loadPermissions() {
    try {
        if (!fs.existsSync(PERMISSIONS_PATH)) {
            return permissionState;
        }
        const data = fs.readFileSync(PERMISSIONS_PATH, 'utf8');
        const loaded = JSON.parse(data);
        permissionState = {
            owners: Array.isArray(loaded.owners) ? loaded.owners : [],
            mods: Array.isArray(loaded.mods) ? loaded.mods : [],
            groups: typeof loaded.groups === 'object' ? loaded.groups : {}
        };
        
        // Auto-add owner from settings if not already in list
        if (settings.ownerNumber && !permissionState.owners.includes(settings.ownerNumber)) {
            permissionState.owners.push(settings.ownerNumber);
            savePermissions();
        }
        
        // Merge existing sudo list into mods
        const existingSudo = loadExistingSudoList();
        for (const sudoJid of existingSudo) {
            if (!permissionState.mods.includes(sudoJid) && !permissionState.owners.includes(sudoJid)) {
                permissionState.mods.push(sudoJid);
            }
        }
        if (existingSudo.length > 0) {
            savePermissions();
        }
        
        return permissionState;
    } catch (error) {
        console.error('[PermissionMiddleware] Error loading permissions:', error.message);
        return permissionState;
    }
}

/**
 * Save permissions to file
 */
function savePermissions() {
    try {
        const dir = path.dirname(PERMISSIONS_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(PERMISSIONS_PATH, JSON.stringify(permissionState, null, 2));
        return true;
    } catch (error) {
        console.error('[PermissionMiddleware] Error saving permissions:', error.message);
        return false;
    }
}

/**
 * Normalize phone number to consistent format
 */
function normalizePhone(jid) {
    if (!jid) return '';
    let normalized = String(jid).replace(/[^0-9]/g, '');
    // Keep at least 9 digits (short numbers might be valid in some regions)
    if (normalized.length < 9) return normalized;
    return normalized;
}

/**
 * Check if user is owner
 */
function isOwner(jid) {
    const normalized = normalizePhone(jid);
    return permissionState.owners.some(owner => normalizePhone(owner) === normalized);
}

/**
 * Check if user is mod
 */
function isMod(jid) {
    const normalized = normalizePhone(jid);
    const isOwnerCheck = isOwner(jid);
    const isModCheck = permissionState.mods.some(mod => normalizePhone(mod) === normalized);
    
    // Debug logging
    console.log(`[PermissionMiddleware] isMod check: jid=${jid}, normalized=${normalized}, isOwner=${isOwnerCheck}, isMod=${isModCheck}, modsList=${JSON.stringify(permissionState.mods)}`);
    
    return isOwnerCheck || isModCheck;
}

/**
 * Check if user is admin in group
 * Uses WhatsApp group metadata to verify admin status
 */
async function isAdmin(sock, chatId, jid) {
    if (!chatId || !chatId.endsWith('@g.us')) {
        return false;
    }
    
    if (isMod(jid)) {
        return true;
    }
    
    try {
        const groupMetadata = await sock.groupMetadata(chatId);
        if (!groupMetadata || !groupMetadata.participants) {
            return false;
        }
        
        const normalized = normalizePhone(jid);
        const participant = groupMetadata.participants.find(
            p => normalizePhone(p.id) === normalized
        );
        
        return participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
    } catch (error) {
        console.error('[PermissionMiddleware] Error checking admin status:', error.message);
        return false;
    }
}

/**
 * Check if user is bot admin (bot has admin rights in group)
 */
async function isBotAdmin(sock, chatId) {
    if (!chatId || !chatId.endsWith('@g.us')) {
        return false;
    }
    
    try {
        const groupMetadata = await sock.groupMetadata(chatId);
        if (!groupMetadata || !groupMetadata.participants) {
            return false;
        }
        
        const botJid = sock.user?.id;
        const normalizedBot = normalizePhone(botJid);
        
        const botParticipant = groupMetadata.participants.find(
            p => normalizePhone(p.id) === normalizedBot
        );
        
        return botParticipant && (botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin');
    } catch (error) {
        console.error('[PermissionMiddleware] Error checking bot admin status:', error.message);
        return false;
    }
}

/**
 * Add owner
 */
function addOwner(jid) {
    const normalized = normalizePhone(jid);
    if (normalized && !permissionState.owners.includes(normalized)) {
        permissionState.owners.push(normalized);
        savePermissions();
        return true;
    }
    return false;
}

/**
 * Remove owner
 */
function removeOwner(jid) {
    const normalized = normalizePhone(jid);
    const index = permissionState.owners.indexOf(normalized);
    if (index !== -1) {
        permissionState.owners.splice(index, 1);
        savePermissions();
        return true;
    }
    return false;
}

/**
 * Add mod
 */
function addMod(jid) {
    const normalized = normalizePhone(jid);
    if (normalized && !permissionState.mods.includes(normalized)) {
        permissionState.mods.push(normalized);
        savePermissions();
        return true;
    }
    return false;
}

/**
 * Remove mod
 */
function removeMod(jid) {
    const normalized = normalizePhone(jid);
    const index = permissionState.mods.indexOf(normalized);
    if (index !== -1) {
        permissionState.mods.splice(index, 1);
        savePermissions();
        return true;
    }
    return false;
}

/**
 * Get user permission level
 */
async function getPermissionLevel(sock, chatId, jid) {
    if (isOwner(jid)) {
        return PERMISSION_LEVELS.OWNER;
    }
    if (isMod(jid)) {
        return PERMISSION_LEVELS.MOD;
    }
    if (chatId && chatId.endsWith('@g.us')) {
        const admin = await isAdmin(sock, chatId, jid);
        if (admin) {
            return PERMISSION_LEVELS.ADMIN;
        }
    }
    return PERMISSION_LEVELS.USER;
}

/**
 * Permission check middleware
 * Returns true if user has required permission
 */
async function hasPermission(sock, chatId, jid, requiredLevel) {
    const userLevel = await getPermissionLevel(sock, chatId, jid);
    
    const levels = {
        [PERMISSION_LEVELS.OWNER]: 4,
        [PERMISSION_LEVELS.MOD]: 3,
        [PERMISSION_LEVELS.ADMIN]: 2,
        [PERMISSION_LEVELS.USER]: 1
    };
    
    return levels[userLevel] >= levels[requiredLevel];
}

/**
 * Initialize permission system
 */
function initialize() {
    loadPermissions();
    console.log('[PermissionMiddleware] Permission system initialized');
}

// Initialize on load
initialize();

module.exports = {
    PERMISSION_LEVELS,
    isOwner,
    isMod,
    isAdmin,
    isBotAdmin,
    addOwner,
    removeOwner,
    addMod,
    removeMod,
    getPermissionLevel,
    hasPermission,
    loadPermissions,
    savePermissions
};
