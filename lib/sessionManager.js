const fs = require('fs');
const path = require('path');
const { getBotDataPath } = require('./botDataPath');

/**
 * Session/Expiry Manager
 * Handles temporary states with 15-minute expiry that persists across restarts
 */

const SESSION_PATH = getBotDataPath('sessions.json');
const EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

// Session state
let sessionState = {
    sessions: {} // { key: { value, timestamp, expiry } }
};

/**
 * Load sessions from file
 */
function loadSessions() {
    try {
        if (!fs.existsSync(SESSION_PATH)) {
            return sessionState;
        }
        const data = fs.readFileSync(SESSION_PATH, 'utf8');
        const loaded = JSON.parse(data);
        sessionState = {
            sessions: typeof loaded.sessions === 'object' ? loaded.sessions : {}
        };
        // Clean expired sessions on load
        cleanExpiredSessions();
        return sessionState;
    } catch (error) {
        console.error('[SessionManager] Error loading sessions:', error.message);
        return sessionState;
    }
}

/**
 * Save sessions to file
 */
function saveSessions() {
    try {
        const dir = path.dirname(SESSION_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(SESSION_PATH, JSON.stringify(sessionState, null, 2));
        return true;
    } catch (error) {
        console.error('[SessionManager] Error saving sessions:', error.message);
        return false;
    }
}

/**
 * Clean expired sessions
 */
function cleanExpiredSessions() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const key in sessionState.sessions) {
        const session = sessionState.sessions[key];
        if (session.expiry && session.expiry < now) {
            delete sessionState.sessions[key];
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        saveSessions();
    }
    
    return cleaned;
}

/**
 * Set session value with expiry
 */
function setSession(key, value, customExpiryMs = null) {
    const now = Date.now();
    const expiry = now + (customExpiryMs || EXPIRY_MS);
    
    sessionState.sessions[key] = {
        value,
        timestamp: now,
        expiry
    };
    
    saveSessions();
    return true;
}

/**
 * Get session value (checks expiry)
 */
function getSession(key) {
    const session = sessionState.sessions[key];
    
    if (!session) {
        return null;
    }
    
    const now = Date.now();
    
    // Check if expired
    if (session.expiry && session.expiry < now) {
        delete sessionState.sessions[key];
        saveSessions();
        return null;
    }
    
    return session.value;
}

/**
 * Check if session exists and is not expired
 */
function hasSession(key) {
    return getSession(key) !== null;
}

/**
 * Delete session
 */
function deleteSession(key) {
    if (sessionState.sessions[key]) {
        delete sessionState.sessions[key];
        saveSessions();
        return true;
    }
    return false;
}

/**
 * Get session info (timestamp, expiry, remaining time)
 */
function getSessionInfo(key) {
    const session = sessionState.sessions[key];
    
    if (!session) {
        return null;
    }
    
    const now = Date.now();
    
    // Check if expired
    if (session.expiry && session.expiry < now) {
        delete sessionState.sessions[key];
        saveSessions();
        return null;
    }
    
    return {
        timestamp: session.timestamp,
        expiry: session.expiry,
        remainingMs: session.expiry - now,
        remainingMinutes: Math.ceil((session.expiry - now) / 60000)
    };
}

/**
 * Clear all sessions
 */
function clearAllSessions() {
    sessionState.sessions = {};
    saveSessions();
    return true;
}

/**
 * Get all active sessions
 */
function getAllSessions() {
    cleanExpiredSessions();
    return Object.keys(sessionState.sessions);
}

/**
 * Get session count
 */
function getSessionCount() {
    cleanExpiredSessions();
    return Object.keys(sessionState.sessions).length;
}

/**
 * Start periodic cleanup (runs every 5 minutes)
 */
function startPeriodicCleanup() {
    setInterval(() => {
        const cleaned = cleanExpiredSessions();
        if (cleaned > 0) {
            console.log(`[SessionManager] Cleaned ${cleaned} expired sessions`);
        }
    }, 5 * 60 * 1000); // 5 minutes
}

/**
 * Initialize session manager
 */
function initialize() {
    loadSessions();
    startPeriodicCleanup();
    console.log('[SessionManager] Session manager initialized with 15-minute expiry');
}

// Initialize on load
initialize();

module.exports = {
    EXPIRY_MS,
    setSession,
    getSession,
    hasSession,
    deleteSession,
    getSessionInfo,
    clearAllSessions,
    getAllSessions,
    getSessionCount,
    cleanExpiredSessions,
    loadSessions,
    saveSessions
};
