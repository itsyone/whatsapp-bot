const fs = require('fs');

// ANSI color codes
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
    bright: '\x1b[1m'
};

// Error tracking for grouping
const errorCounts = new Map();
const lastErrorLogTime = new Map();
const suppressedLogs = new Map();
const lastStoreSizeLog = { size: 0, time: 0 };

// Get timestamp in HH:MM:SS format
function getTimestamp() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `[${hours}:${minutes}:${seconds}]`;
}

// Clean up JSON.stringify dumps
function cleanStringify(obj) {
    if (typeof obj === 'string') return obj;
    try {
        const str = JSON.stringify(obj);
        if (str.length > 200) {
            return str.substring(0, 200) + '...';
        }
        return str;
    } catch {
        return '[Unstringifiable]';
    }
}

// Check if log should be suppressed (max once per 60 seconds)
function shouldSuppressLog(key) {
    const now = Date.now();
    const lastLog = suppressedLogs.get(key);
    if (!lastLog || now - lastLog > 60000) {
        suppressedLogs.set(key, now);
        return false;
    }
    return true;
}

// Track store size for 2MB threshold check
function shouldLogStoreSize(sizeMB) {
    const now = Date.now();
    const sizeDiff = Math.abs(sizeMB - lastStoreSizeLog.size);
    const timeDiff = now - lastStoreSizeLog.time;
    
    // Log if size increased by > 2MB or never logged before
    if (sizeDiff > 2 || lastStoreSizeLog.time === 0) {
        lastStoreSizeLog.size = sizeMB;
        lastStoreSizeLog.time = now;
        return true;
    }
    // Also log at least once per minute
    if (timeDiff > 60000) {
        lastStoreSizeLog.time = now;
        return true;
    }
    return false;
}

// Main logger functions
const logger = {
    info: (message, context = {}) => {
        const msg = cleanStringify(message);
        const ctx = Object.keys(context).length > 0 ? ` ${cleanStringify(context)}` : '';
        console.log(`${colors.cyan}${getTimestamp()} [INFO]${colors.reset} ${msg}${ctx}`);
    },

    warn: (message, context = {}) => {
        const msg = cleanStringify(message);
        const ctx = Object.keys(context).length > 0 ? ` ${cleanStringify(context)}` : '';
        console.log(`${colors.yellow}${getTimestamp()} [WARN]${colors.reset} ${msg}${ctx}`);
    },

    error: (message, context = {}) => {
        const msg = cleanStringify(message);
        const key = msg + JSON.stringify(context);
        const count = (errorCounts.get(key) || 0) + 1;
        errorCounts.set(key, count);
        
        // Only log first time, then every 3rd occurrence, and once per minute max
        const now = Date.now();
        const lastLog = lastErrorLogTime.get(key);
        const shouldLog = count === 1 || count % 3 === 0 || !lastLog || now - lastLog > 60000;
        
        if (shouldLog) {
            lastErrorLogTime.set(key, now);
            const countStr = count > 1 ? ` (x${count})` : '';
            const ctx = Object.keys(context).length > 0 ? ` ${cleanStringify(context)}` : '';
            console.log(`${colors.red}${getTimestamp()} [ERROR]${colors.reset} ${msg}${countStr}${ctx}`);
        }
    },

    debug: (message, context = {}) => {
        const msg = cleanStringify(message);
        const ctx = Object.keys(context).length > 0 ? ` ${cleanStringify(context)}` : '';
        console.log(`${colors.gray}${getTimestamp()} [DEBUG]${colors.reset} ${msg}${ctx}`);
    },

    // Specialized loggers for common patterns
    parseFile: (filename, sizeMB) => {
        const key = `parse:${filename}`;
        if (shouldSuppressLog(key)) return;
        logger.debug(`Parsing large file: ${filename} (${sizeMB.toFixed(2)} MB)`);
    },

    storeSize: (filename, sizeMB) => {
        if (!shouldLogStoreSize(sizeMB)) return;
        logger.warn(`Main store file is too large (${sizeMB.toFixed(2)} MB). Skipping to prevent OOM.`);
    },

    // Reset error counts (call periodically to prevent memory buildup)
    resetCounts: () => {
        const now = Date.now();
        for (const [key, lastTime] of lastErrorLogTime.entries()) {
            if (now - lastTime > 300000) { // 5 minutes
                errorCounts.delete(key);
                lastErrorLogTime.delete(key);
            }
        }
    }
};

// Reset counts every 5 minutes
setInterval(logger.resetCounts, 300000);

module.exports = logger;
