const fs = require('fs')
const path = require('path')
const { readJsonSafe, writeJsonSafe } = require('../utils/jsonStore')
const logger = require('./logger')
const STORE_FILE = './baileys_store.json'

// Config: keep last 20 messages per chat (configurable) - More aggressive for lower RAM
let MAX_MESSAGES = 20
let lastSerializedStore = ''
let writeInFlight = false

// Try to read config from settings
try {
    const settings = require('../settings.js')
    if (settings.maxStoreMessages && typeof settings.maxStoreMessages === 'number') {
        MAX_MESSAGES = settings.maxStoreMessages
    }
} catch (e) {
    // Use default if settings not available
}

function getStorePaths(filePath) {
    const resolved = path.resolve(filePath)
    return {
        main: resolved,
        temp: `${resolved}.tmp`,
        backup: `${resolved}.bak`
    }
}

function safeReadJson(filePath) {
    return readJsonSafe(filePath, null)
}

const store = {
    messages: {},
    contacts: {},
    chats: {},

    readFromFile(filePath = STORE_FILE) {
        const paths = getStorePaths(filePath)
        try {
            // Check file size before reading to prevent OOM
            if (fs.existsSync(paths.main)) {
                const stats = fs.statSync(paths.main);
                const sizeMb = stats.size / (1024 * 1024);
                if (sizeMb > 20) {
                    logger.storeSize('baileys_store.json', sizeMb);
                    // Optionally backup the large file before skipping
                    if (!fs.existsSync(paths.backup)) {
                        fs.copyFileSync(paths.main, paths.backup);
                    }
                } else {
                    const data = safeReadJson(paths.main);
                    if (data) {
                        this.contacts = data.contacts || {};
                        this.chats = data.chats || {};
                        this.messages = data.messages || {};
                        this.cleanupData();
                        return;
                    }
                }
            }
        } catch (e) {
            console.warn('Failed to read store file:', e.message)
        }

        try {
            const backupData = safeReadJson(paths.backup)
            if (backupData) {
                this.contacts = backupData.contacts || {}
                this.chats = backupData.chats || {}
                this.messages = backupData.messages || {}
                this.cleanupData()
                console.warn('Recovered store from backup file')
                try {
                    fs.copyFileSync(paths.backup, paths.main)
                } catch (copyError) {
                    console.warn('Failed to restore main store from backup:', copyError.message)
                }
                return
            }
        } catch (e) {
            console.warn('Failed to read store backup file:', e.message)
        }
    },

    writeToFile(filePath = STORE_FILE) {
        if (writeInFlight) return
        try {
            this.pruneStore()
            const data = JSON.stringify({
                contacts: this.contacts,
                chats: this.chats,
                messages: this.messages
            }); // Without null, 2 spacing for massive speed boost

            if (data === lastSerializedStore) return

            writeInFlight = true
            const tempPath = filePath + '.tmp';
            fs.writeFile(tempPath, data, 'utf8', (err) => {
                if (!err) {
                    fs.rename(tempPath, filePath, () => {
                        writeInFlight = false;
                        lastSerializedStore = data;
                    });
                    return;
                }
                writeInFlight = false;
            });
        } catch (e) {
            writeInFlight = false
            console.warn('Failed to stringify store data:', e.message)
        }
    },

    cleanupData() {
        // Convert old format messages to new format if needed
        if (this.messages) {
            Object.keys(this.messages).forEach(jid => {
                if (typeof this.messages[jid] === 'object' && !Array.isArray(this.messages[jid])) {
                    // Old format - convert to new format
                    const messages = Object.values(this.messages[jid])
                    this.messages[jid] = messages.slice(-MAX_MESSAGES)
                }
            })
        }
        this.pruneStore();
    },

    pruneStore() {
        const now = Date.now();
        const TWELVE_HOURS = 12 * 60 * 60 * 1000;
        const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

        // Prune old messages
        Object.keys(this.messages).forEach(jid => {
            this.messages[jid] = this.messages[jid].filter(m => {
                const timestamp = (m.messageTimestamp?.low || m.messageTimestamp || 0) * 1000;
                return timestamp > (now - TWELVE_HOURS);
            }).slice(-MAX_MESSAGES);
            
            if (this.messages[jid].length === 0) delete this.messages[jid];
        });

        // Prune inactive chats/contacts (placeholder for future activity tracking)
        // For now, just ensure the store doesn't leak memory
        if (Object.keys(this.contacts).length > 2000) {
            this.contacts = {}; // Reset large contact list occasionally to keep startup fast
        }
    },

    bind(ev) {
        ev.on('messages.upsert', ({ messages }) => {
            messages.forEach(msg => {
                if (!msg.key?.remoteJid) return
                
                // Update contacts with pushName if available
                const senderId = msg.key.participant || msg.key.remoteJid;
                if (msg.pushName && senderId && !senderId.endsWith('@g.us')) {
                    this.contacts[senderId] = {
                        id: senderId,
                        name: msg.pushName
                    };
                }

                const jid = msg.key.remoteJid
                this.messages[jid] = this.messages[jid] || []

                // push new message
                this.messages[jid].push(msg)

                // trim old ones
                if (this.messages[jid].length > MAX_MESSAGES) {
                    this.messages[jid] = this.messages[jid].slice(-MAX_MESSAGES)
                }
            })
        })

        ev.on('contacts.update', (contacts) => {
            contacts.forEach(contact => {
                if (contact.id) {
                    this.contacts[contact.id] = {
                        id: contact.id,
                        name: contact.notify || contact.name || ''
                    }
                }
            })
        })

        ev.on('chats.set', (chats) => {
            this.chats = {}
            chats.forEach(chat => {
                this.chats[chat.id] = { id: chat.id, subject: chat.subject || '' }
            })
        })
    },

    async loadMessage(jid, id) {
        return this.messages[jid]?.find(m => m.key.id === id) || null
    },

    // Get store statistics
    getStats() {
        let totalMessages = 0
        let totalContacts = Object.keys(this.contacts).length
        let totalChats = Object.keys(this.chats).length
        
        Object.values(this.messages).forEach(chatMessages => {
            if (Array.isArray(chatMessages)) {
                totalMessages += chatMessages.length
            }
        })
        
        return {
            messages: totalMessages,
            contacts: totalContacts,
            chats: totalChats,
            maxMessagesPerChat: MAX_MESSAGES
        }
    }
}

module.exports = store
