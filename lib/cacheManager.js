/**
 * Cache Manager with TTL and Size Limits
 * Prevents memory leaks and unbounded cache growth
 */

class CacheManager {
    constructor(options = {}) {
        this.maxSize = options.maxSize || 1000;
        this.defaultTTL = options.defaultTTL || 15 * 60 * 1000; // 15 minutes
        this.cache = new Map();
        this.timers = new Map();
        this.cleanupInterval = options.cleanupInterval || 5 * 60 * 1000; // 5 minutes
        
        // Start periodic cleanup
        this.startCleanup();
    }

    /**
     * Set a value in cache with optional TTL
     */
    set(key, value, ttl = null) {
        // Remove oldest item if at capacity
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.delete(firstKey);
        }

        const expiry = ttl ? Date.now() + ttl : Date.now() + this.defaultTTL;
        
        this.cache.set(key, { value, expiry });
        
        // Set up automatic deletion
        if (this.timers.has(key)) {
            clearTimeout(this.timers.get(key));
        }
        
        const timer = setTimeout(() => {
            this.delete(key);
        }, ttl || this.defaultTTL);
        
        this.timers.set(key, timer);
    }

    /**
     * Get a value from cache (returns null if expired or not found)
     */
    get(key) {
        const item = this.cache.get(key);
        
        if (!item) {
            return null;
        }

        // Check if expired
        if (item.expiry && item.expiry < Date.now()) {
            this.delete(key);
            return null;
        }

        return item.value;
    }

    /**
     * Check if key exists and is not expired
     */
    has(key) {
        return this.get(key) !== null;
    }

    /**
     * Delete a value from cache
     */
    delete(key) {
        if (this.timers.has(key)) {
            clearTimeout(this.timers.get(key));
            this.timers.delete(key);
        }
        return this.cache.delete(key);
    }

    /**
     * Clear all cache entries
     */
    clear() {
        // Clear all timers
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
        this.cache.clear();
    }

    /**
     * Get cache size
     */
    size() {
        return this.cache.size;
    }

    /**
     * Clean up expired entries
     */
    cleanup() {
        const now = Date.now();
        let cleaned = 0;
        
        for (const [key, item] of this.cache.entries()) {
            if (item.expiry && item.expiry < now) {
                this.delete(key);
                cleaned++;
            }
        }
        
        return cleaned;
    }

    /**
     * Start periodic cleanup
     */
    startCleanup() {
        this.cleanupTimer = setInterval(() => {
            const cleaned = this.cleanup();
            if (cleaned > 0) {
                console.log(`[CacheManager] Cleaned ${cleaned} expired cache entries`);
            }
        }, this.cleanupInterval);
    }

    /**
     * Stop periodic cleanup
     */
    stopCleanup() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }

    /**
     * Get cache statistics
     */
    getStats() {
        const now = Date.now();
        let expiredCount = 0;
        
        for (const item of this.cache.values()) {
            if (item.expiry && item.expiry < now) {
                expiredCount++;
            }
        }

        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            expiredCount,
            usagePercent: Math.round((this.cache.size / this.maxSize) * 100)
        };
    }
}

// Create singleton instances for common use cases
const commandCache = new CacheManager({ maxSize: 500, defaultTTL: 10 * 60 * 1000 }); // 10 min TTL
const spamCache = new CacheManager({ maxSize: 1000, defaultTTL: 5 * 60 * 1000 }); // 5 min TTL
const sessionCache = new CacheManager({ maxSize: 2000, defaultTTL: 15 * 60 * 1000 }); // 15 min TTL

module.exports = {
    CacheManager,
    commandCache,
    spamCache,
    sessionCache
};
