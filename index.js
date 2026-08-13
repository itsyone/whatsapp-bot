const Module = require('module')
const bootstrapPath = require('path')
const originalResolveFilename = Module._resolveFilename

Module._resolveFilename = function(request, parent, isMain, options) {
    if (request === 'axios') {
        return bootstrapPath.join(__dirname, 'lib', 'axiosShim.js')
    }
    return originalResolveFilename.call(this, request, parent, isMain, options)
}

require('./settings')
const { cleanupPlayerScripts, clearTempDirectories } = require('./lib/startupCleanup')
const { runWithBotContext } = require('./lib/botContext')
const cleartmpCommand = require('./commands/admin/cleartmp')

// Initialize directories and clear old cache
clearTempDirectories();
cleartmpCommand.init?.(); // FIXED: explicit cleartmp scheduler init
const { loadBotProfiles } = require('./lib/botProfiles')
const { handleMangaPollVote } = require('./commands/media/manga');
const fs = require('fs')
const chalk = require('./lib/chalkSafe')
const { installCompactConsole, formatLogLine } = require('./utils/logger')
const FileType = require('file-type')
const path = require('path')
const axios = require('axios')
const PhoneNumber = require('awesome-phonenumber')
const { getBaileys } = require('./lib/baileys')
const { imageToWebp, videoToWebp, writeExifImg, writeExifVid } = require('./lib/exif')
const { smsg, isUrl, generateMessageTag, getBuffer, getSizeMedia, fetch, await, sleep, reSize } = require('./lib/myfunc')
const NodeCache = require("node-cache")
const pino = require("pino")
const readline = require("readline")
let qrTerminal = null
try {
    qrTerminal = require('qrcode-terminal')
} catch { }
let qrCodeImage = null
try {
    qrCodeImage = require('qrcode')
} catch { }
const { parsePhoneNumber } = require("libphonenumber-js")
const { rmSync, existsSync } = require('fs')
const { join } = require('path')

const HOT_RELOAD_ROOTS = [
    path.join(__dirname, 'commands'),
    path.join(__dirname, 'lib'),
]
const HOT_RELOAD_FILES = [
    path.join(__dirname, 'main.js'),
    path.join(__dirname, 'settings.js'),
    path.join(__dirname, 'config.js'),
    path.join(__dirname, 'lib', 'mongoAuthState.js'),
]
const HOT_RELOAD_ENABLED = process.env.BOT_HOT_RELOAD === '1' || process.env.NODE_ENV !== 'production'
const watchedDirs = global.__eclipseWatchedDirs || (global.__eclipseWatchedDirs = new Set())
const watchedFiles = global.__eclipseWatchedFiles || (global.__eclipseWatchedFiles = new Map())
const reloadDebounce = new Map()
let hotReloadRetryTimer = null
const dedupedLogState = new Map()
const reconnectTimers = new Map()
const bootInProgress = new Set()
const pairingCodeRequested = new Set()
const activeBots = new Map()
const liveSockets = new Map()
let cachedBaileysVersion = [2, 3000, 1035194821]
let baileysVersionLookupAttempted = false

const fallbackMainHandlers = {
    handleMessages: async () => { },
    handleGroupParticipantUpdate: async () => { },
    handleStatus: async () => { },
}

let mainHandlers = { ...fallbackMainHandlers }

function normalizeExternalAdReplyConfig(externalAdReply) {
    if (!externalAdReply || typeof externalAdReply !== 'object') return externalAdReply

    const normalized = { ...externalAdReply }
    const candidateUrl = [
        normalized.url,
        normalized.sourceUrl,
        normalized.mediaUrl,
        normalized.thumbnailUrl
    ].find((value) => typeof value === 'string' && value.trim())

    if (candidateUrl) normalized.url = candidateUrl
    normalized.largeThumbnail = Boolean(
        normalized.largeThumbnail ?? normalized.renderLargerThumbnail
    )

    delete normalized.renderLargerThumbnail
    delete normalized.sourceUrl
    delete normalized.mediaUrl
    delete normalized.thumbnailUrl

    return normalized
}

function normalizeOutgoingThumbPayload(message) {
    if (!message || typeof message !== 'object' || Buffer.isBuffer(message)) return message

    if (message.viewOnceMessage?.message) {
        return {
            ...message,
            viewOnceMessage: {
                ...message.viewOnceMessage,
                message: normalizeOutgoingThumbPayload(message.viewOnceMessage.message)
            }
        }
    }

    if (message.ephemeralMessage?.message) {
        return {
            ...message,
            ephemeralMessage: {
                ...message.ephemeralMessage,
                message: normalizeOutgoingThumbPayload(message.ephemeralMessage.message)
            }
        }
    }

    const nestedExternalAdReply = message.contextInfo?.externalAdReply
    const topLevelExternalAdReply = message.externalAdReply

    if (!nestedExternalAdReply && !topLevelExternalAdReply) return message

    const normalizedExternalAdReply = normalizeExternalAdReplyConfig(
        topLevelExternalAdReply || nestedExternalAdReply
    )

    const nextContextInfo = message.contextInfo ? { ...message.contextInfo } : undefined
    if (nextContextInfo?.externalAdReply) delete nextContextInfo.externalAdReply

    return {
        ...message,
        ...(nextContextInfo && Object.keys(nextContextInfo).length ? { contextInfo: nextContextInfo } : {}),
        externalAdReply: normalizedExternalAdReply
    }
}

const originalConsole = installCompactConsole()
const originalConsoleLog = originalConsole.log
const originalConsoleWarn = originalConsole.warn
const originalConsoleError = originalConsole.error

// Install session-error filter on console.error once at module level.
;(function installSessionErrorFilter() {
    const baseError = originalConsoleError
    console.error = function(...args) {
        const strArgs = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
        const suppress = [
            '"hostname"', '"level"', 'no name present',
            'Buffer timeout', 'timed out waiting', 'printQRInTerminal',
            'Uploading PreKeys', 'uploading pre-keys', 'uploaded pre-keys',
            'injecting new app state', 'not logged in, attempting',
            'auto-flushing', 'will not send message',
            '[DEBUG WA:', 'Profile Data:', '[SYS] Baileys',
            'Garbage collection', 'RAM too high',
            '[PermissionMiddleware]', '[SessionManager]', '[SUMMON]'
        ]
        if (suppress.some(s => strArgs.includes(s))) return // FIXED: suppress known noisy runtime console spam

        const fullMessage = formatLogLine(args)
        const errorMessage = fullMessage.toLowerCase()
        const isSessionError = (
            (errorMessage.includes('session error') && errorMessage.includes('bad mac')) ||
            errorMessage.includes('failed to decrypt message with any known session') ||
            (errorMessage.includes('error: bad mac') && errorMessage.includes('verifymac')) ||
            (errorMessage.includes('bad mac') && (errorMessage.includes('session') || errorMessage.includes('decrypt'))) ||
            errorMessage.includes('messagecountererror') ||
            errorMessage.includes('buffer timeout') ||
            errorMessage.includes('auto-flushing') ||
            errorMessage.includes('will not send message again') ||
            errorMessage.includes('sent too many times')
        )
        if (!isSessionError) {
            baseError(fullMessage)
        }
    }
})()

// Install suppress filter on console.log and console.warn.
;(function installSuppressFilter() {
    const baseLog = originalConsoleLog
    const baseWarn = originalConsoleWarn

    const suppress = [
        '"hostname"', '"level"', 'no name present',
        'Buffer timeout', 'timed out waiting', 'printQRInTerminal',
        'Uploading PreKeys', 'uploading pre-keys', 'uploaded pre-keys',
        'injecting new app state', 'not logged in, attempting',
        'auto-flushing', 'will not send message',
        '[DEBUG WA:', 'Profile Data:', '[SYS] Baileys',
        'Garbage collection', 'RAM too high',
        '[PermissionMiddleware]', '[SessionManager]', '[SUMMON]'
    ]

    const shouldSuppress = (args) => {
        const strArgs = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
        return suppress.some(s => strArgs.includes(s))
    }

    console.log = function(...args) {
        if (shouldSuppress(args)) return
        baseLog(...args)
    }

    console.warn = function(...args) {
        if (shouldSuppress(args)) return
        baseWarn(...args)
    }
})()

function printStartupCard(botProfile, botUser, ownerValue, versionValue) {
    const botName = botProfile?.botName || global.botname || 'Bot';
    const accountName = botUser?.name || 'Unknown';
    const accountId = String(botUser?.id || '').split(':')[0] || 'Unknown';
    const versionText = Array.isArray(versionValue) ? versionValue.join('.') : String(versionValue || 'default');
    const lines = [
        ` ${botName} BOT ONLINE `,
        ` Account : ${accountName}`,
        ` Number  : ${accountId}`,
        ` Owner   : ${ownerValue}`,
        ` Baileys : ${versionText}`,
        ' Status  : Connected'
    ];
    const width = Math.max(...lines.map((line) => line.length));
    const border = `┌${'─'.repeat(width + 2)}┐`;
    const divider = `├${'─'.repeat(width + 2)}┤`;
    const bottom = `└${'─'.repeat(width + 2)}┘`;

    originalConsoleLog(chalk.cyan(border));
    originalConsoleLog(chalk.cyan(`│ ${lines[0].padEnd(width)} │`));
    originalConsoleLog(chalk.cyan(divider));
    for (const line of lines.slice(1)) {
        originalConsoleLog(chalk.cyan(`│ ${line.padEnd(width)} │`));
    }
    originalConsoleLog(chalk.cyan(bottom));
}

const removedPlayerScripts = cleanupPlayerScripts()
if (removedPlayerScripts > 0) {
    console.log(`[CLEANUP] Removed ${removedPlayerScripts} old YouTube player script file(s)`)
}

function loadMainHandlers(options = {}) {
    const { quiet = false } = options
    try {
        const mainPath = require.resolve('./main')
        delete require.cache[mainPath]
        const mod = require('./main')
        const nextHandlers = {
            handleMessages: typeof mod?.handleMessages === 'function' ? mod.handleMessages : null,
            handleGroupParticipantUpdate: typeof mod?.handleGroupParticipantUpdate === 'function' ? mod.handleGroupParticipantUpdate : null,
            handleStatus: typeof mod?.handleStatus === 'function' ? mod.handleStatus : null,
        }
        const hasRequiredHandlers = nextHandlers.handleMessages && nextHandlers.handleGroupParticipantUpdate && nextHandlers.handleStatus

        if (!hasRequiredHandlers) {
            const exportedKeys = mod && typeof mod === 'object' ? Object.keys(mod) : []
            if (!quiet) {
                console.error('Main handlers loaded with invalid export shape:', exportedKeys)
            }
            return mainHandlers || { ...fallbackMainHandlers }
        }

        if (hotReloadRetryTimer) {
            clearTimeout(hotReloadRetryTimer)
            hotReloadRetryTimer = null
        }
        return nextHandlers
    } catch (err) {
        const message = err?.message || String(err)
        const isModuleRace = err?.code === 'MODULE_NOT_FOUND'
        if (!quiet) {
            console.error('Hot-reload failed to load main handlers:', message)
        }
        if (isModuleRace && !hotReloadRetryTimer) {
            hotReloadRetryTimer = setTimeout(() => {
                hotReloadRetryTimer = null
                mainHandlers = loadMainHandlers({ quiet: true }) || mainHandlers || { ...fallbackMainHandlers }
                if (mainHandlers?.handleMessages) {
                    console.log(chalk.yellow('[HOT-RELOAD] Recovered after delayed retry'))
                }
            }, 800)
        }
        return mainHandlers || { ...fallbackMainHandlers }
    }
}

mainHandlers = loadMainHandlers()

function clearCachePrefix(prefixPath) {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(prefixPath)) {
            delete require.cache[key]
        }
    }
}

function scheduleHotReload(changedPath) {
    if (!changedPath) return
    const abs = path.resolve(changedPath)
    const shouldReloadFile =
        HOT_RELOAD_FILES.includes(abs) ||
        abs.endsWith('.js')
    if (!shouldReloadFile) return
    clearTimeout(reloadDebounce.get(abs))
    const timer = setTimeout(() => {
        try {
            if (abs.endsWith('.js')) {
                delete require.cache[abs]
            }
            if (abs.startsWith(path.join(__dirname, 'commands')) || abs.startsWith(path.join(__dirname, 'lib'))) {
                clearCachePrefix(path.join(__dirname, 'commands'))
                clearCachePrefix(path.join(__dirname, 'lib'))
            }
            mainHandlers = loadMainHandlers()
            // console.log(chalk.greenBright(`[HOT-RELOAD] Updated: ${path.relative(__dirname, abs)}`))
        } catch (err) {
            console.error('Hot-reload error:', err?.message || err)
        }
    }, 350)
    reloadDebounce.set(abs, timer)
}

function watchDirTree(dirPath) {
    if (!existsSync(dirPath) || watchedDirs.has(dirPath)) return
    watchedDirs.add(dirPath)

    try {
        fs.watch(dirPath, (eventType, filename) => {
            if (!filename) return
            const changed = path.join(dirPath, filename.toString())
            if (existsSync(changed)) {
                try {
                    if (fs.statSync(changed).isDirectory()) {
                        watchDirTree(changed)
                    }
                } catch { }
            }
            scheduleHotReload(changed)
        })
    } catch (err) {
        console.error(`Watcher error on ${dirPath}:`, err?.message || err)
    }

    try {
        for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                watchDirTree(path.join(dirPath, entry.name))
            }
        }
    } catch { }
}

function setupHotReload() {
    if (!HOT_RELOAD_ENABLED) return
    HOT_RELOAD_FILES.forEach(file => {
        if (!existsSync(file)) return
        if (watchedFiles.has(file)) return
        const listener = () => scheduleHotReload(file)
        watchedFiles.set(file, listener)
        fs.watchFile(file, { interval: 500 }, listener)
    })
    HOT_RELOAD_ROOTS.forEach(watchDirTree)
}

function logWithDedupe(key, message, windowMs = 5000, logger = originalConsoleLog) {
    const now = Date.now()
    const last = Number(dedupedLogState.get(key) || 0)
    if (now - last < windowMs) return
    dedupedLogState.set(key, now)
    logger(message)
}

// Import lightweight store
const store = require('./lib/lightweight_store')

// Initialize store
store.readFromFile()
const settings = require('./settings')
setInterval(() => store.writeToFile(), settings.storeWriteInterval || 60000)
setupHotReload()

// Memory optimization - Force garbage collection if available
setInterval(() => {
    if (global.gc) {

        global.gc()
        console.log('🧹 Garbage collection completed')
    }
}, 60_000) // every 1 minute

// Memory monitoring - Restart if RAM gets too high
setInterval(() => {
    const used = process.memoryUsage().rss / 1024 / 1024
    if (used > 1000) {
        console.log('⚠️ RAM too high (>1000MB), restarting bot...')
        process.exit(1) // Panel will auto-restart
    }
}, 30_000) // check every 30 seconds

// Memory monitoring - Restart if RAM gets too high
setInterval(() => {
    const used = process.memoryUsage().rss / 1024 / 1024
    if (used > 1000) {
        console.log('⚠️ RAM too high (>1000MB), restarting bot...')
        process.exit(1) // Panel will auto-restart
    }
}, 30_000) // check every 30 seconds

let phoneNumber = settings.ownerNumber || global.phoneNumber || ""
let owner = JSON.parse(fs.readFileSync('./data/owner.json'))

global.botname = settings.botName || "Eclipse"
global.themeemoji = "•"
const useMobile = process.argv.includes("--mobile")

// Only create readline interface if we're in an interactive environment
const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null
const question = (text) => {
    if (rl) {
        return new Promise((resolve) => rl.question(text, resolve))
    } else {
        // In non-interactive environment, use ownerNumber from settings
        return Promise.resolve(settings.ownerNumber || phoneNumber)
    }
}

function hasInteractiveReplyPayload(message = {}) {
    if (!message || typeof message !== 'object') return false

    if (
        message.interactiveResponseMessage ||
        message.buttonsResponseMessage ||
        message.templateButtonReplyMessage ||
        message.listResponseMessage
    ) {
        return true
    }

    return Object.values(message).some((value) => {
        if (!value || typeof value !== 'object') return false
        return hasInteractiveReplyPayload(value)
    })
}

async function startBot(botProfile) {
    const profile = botProfile || { botId: 'eclipse', botName: settings.botName || 'Eclipse', sessionDir: path.join(process.cwd(), 'session', 'eclipse') }
    const botId = String(profile.botId || 'eclipse')
    const pairingMode = String(profile.pairingMode || 'code').trim().toLowerCase() === 'qr' ? 'qr' : 'code'
    const pairingCodeEnabled = pairingMode !== 'qr' && (Boolean(String(profile.pairingNumber || profile.ownerNumber || global.phoneNumber || '').trim()) || process.argv.includes("--pairing-code"))
    if (bootInProgress.has(botId)) return null
    bootInProgress.add(botId)
    try {
    const {
        default: makeWASocket,
        useMultiFileAuthState,
        DisconnectReason,
        Browsers,
        fetchLatestBaileysVersion,
        generateForwardMessageContent,
        prepareWAMessageMedia,
        generateWAMessageFromContent,
        generateMessageID,
        downloadContentFromMessage,
        jidDecode,
        proto,
        jidNormalizedUser,
        makeCacheableSignalKeyStore,
        delay
    } = await getBaileys()
    let version = cachedBaileysVersion
    if (!baileysVersionLookupAttempted) {
        baileysVersionLookupAttempted = true
        try {
            const latest = await fetchLatestBaileysVersion()
            if (Array.isArray(latest?.version)) {
                cachedBaileysVersion = latest.version
                version = latest.version
            }
        } catch {}
    }
    if (Array.isArray(version)) {
        if (Array.isArray(version)) {
        console.log(chalk.cyan(`Using Baileys version: ${version.join('.')}`))
    } else {
        console.log(chalk.cyan('Using Baileys default bundled version'))
    }
    } else {
        console.log(chalk.cyan('Using Baileys default bundled version'))
    }
    const { state, saveCreds } = await useMultiFileAuthState(profile.sessionDir || path.join(process.cwd(), 'session', botId))
    const msgRetryCounterCache = new NodeCache()
    const groupMetadataCache = new NodeCache({ stdTTL: 5 * 60, useClones: false }) // FIXED: Baileys cachedGroupMetadata

    const existingSocket = liveSockets.get(botId)
    if (existingSocket) {
        try {
            existingSocket.ev?.removeAllListeners?.()
        } catch { }
        try {
            existingSocket.ws?.close?.()
        } catch { }
        try {
            existingSocket.end?.()
        } catch { }
        liveSockets.delete(botId)
        activeBots.delete(botId)
    }

    const Bot = makeWASocket({
        ...(Array.isArray(version) ? { version } : {}),
        logger: pino({ level: process.env.BOT_LOG_LEVEL || 'fatal' }),
        printQRInTerminal: pairingMode === 'qr',
        generateHighQualityLinkPreview: true, // FIXED: high-quality official link previews
        markOnlineOnConnect: false, // FIXED: Baileys socket config for less connect-side churn
        cachedGroupMetadata: async (jid) => groupMetadataCache.get(jid), // FIXED: Baileys group metadata cache
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
        },
        getMessage: async (key) => {
            let jid = jidNormalizedUser(key.remoteJid)
            let msg = await store.loadMessage(jid, key.id)
            return msg?.message || ""
        },
    })
    Bot.botId = botId
    Bot.profile = profile
    liveSockets.set(botId, Bot)

    const originalSendMessage = Bot.sendMessage.bind(Bot)
    Bot.sendMessage = (jid, content, options = {}) => {
        return originalSendMessage(jid, normalizeOutgoingThumbPayload(content), options)
    } // FIXED: normalize legacy thumb cards into Baileys' top-level externalAdReply format for mobile clients

    const originalGroupMetadata = Bot.groupMetadata.bind(Bot)
    Bot.groupMetadata = async (jid) => {
        const cached = groupMetadataCache.get(jid)
        if (cached) return cached
        const metadata = await originalGroupMetadata(jid)
        groupMetadataCache.set(jid, metadata)
        return metadata
    } // FIXED: shared group metadata cache across command sends and admin checks

    store.bind(Bot.ev)

    // Suppress session/decryption errors from spamming console
    // These errors come from libsignal library and are common/non-critical
    const baseConsoleError = originalConsoleError;
    console.error = function(...args) {
        const fullMessage = formatLogLine(args);
        const errorMessage = fullMessage.toLowerCase();

        // Filter out common Baileys/libsignal session errors that spam the console
        // Match exact patterns
        const isSessionError = (
            // "Session error:Error: Bad MAC"
            (errorMessage.includes('session error') && errorMessage.includes('bad mac')) ||
            // "Failed to decrypt message with any known session..."
            errorMessage.includes('failed to decrypt message with any known session') ||
            // "Error: Bad MAC" (from libsignal crypto.js)
            (errorMessage.includes('error: bad mac') && errorMessage.includes('verifyMAC')) ||
            // General Bad MAC errors from session cipher
            (errorMessage.includes('bad mac') && (errorMessage.includes('session') || errorMessage.includes('decrypt'))) ||
            // "MessageCounterError: Key used already or never filled"
            errorMessage.includes('messagecountererror')
        );

        // Only log if it's not a session/decryption error
        if (!isSessionError) {
            baseConsoleError(fullMessage);
        }
        // Silently ignore session/decryption errors to prevent spam
    }

    // Handle Baileys internal errors gracefully
    Bot.ev.on('error', (error) => {
        // Suppress session-related errors
        const errorMsg = error?.message?.toLowerCase() || '';
        if (errorMsg.includes('bad mac') || 
            errorMsg.includes('failed to decrypt') || 
            errorMsg.includes('session error') ||
            errorMsg.includes('messagecountererror')) {
            // Silently ignore - these are common and don't need to spam logs
            return;
        }
        // Only log non-session errors
        if (!errorMsg.includes('bad mac') && !errorMsg.includes('session')) {
            baseConsoleError('Baileys error:', error?.message || error);
        }
    });

    // Message handling
    Bot.ev.on('messages.upsert', async chatUpdate => {
        try {
            for (const rawMessage of chatUpdate.messages || []) {
                const mek = rawMessage
                if (!mek?.message) continue
                mek.message = (Object.keys(mek.message)[0] === 'ephemeralMessage') ? mek.message.ephemeralMessage.message : mek.message
                const isInteractiveReply = hasInteractiveReplyPayload(mek.message)
                if (mek.key && mek.key.remoteJid === 'status@broadcast') {
                    await runWithBotContext({ bot: Bot, profile }, async () => {
                        await mainHandlers.handleStatus(Bot, { ...chatUpdate, messages: [mek] });
                    });
                    continue
                }
                const isReplayUpsert = chatUpdate.type === 'append' // FIXED: offline queued message processing
                if (!Bot.public && !mek.key.fromMe && chatUpdate.type === 'notify' && !isReplayUpsert) continue
                if (isInteractiveReply) {
                    console.log(`[interactive] upsert type=${chatUpdate.type} id=${mek.key?.id || ''}`)
                }

                try {
                    await runWithBotContext({ bot: Bot, profile }, async () => {
                        await mainHandlers.handleMessages(Bot, { ...chatUpdate, messages: [mek] }, true) // FIXED: process every upsert message
                    })
                } catch (err) {
                    console.error("Error in handleMessages:", err)
                    if (err.stack) {
                        console.error("Stack trace:", err.stack);
                    }
                }
            }
        } catch (err) {
            console.error("Error in messages.upsert:", err)
        }
    })

    Bot.ev.on('groups.update', (updates = []) => {
        for (const update of updates) {
            const id = update?.id
            if (id) groupMetadataCache.del(id)
        }
    }) // FIXED: invalidate cached group metadata on group updates

    Bot.ev.on('group-participants.update', (update = {}) => {
        if (update?.id) groupMetadataCache.del(update.id)
    }) // FIXED: invalidate cached group metadata on participant changes

    Bot.ev.on('messages.update', async (updates) => {
        try {
            await runWithBotContext({ bot: Bot, profile }, async () => {
                for (const update of updates || []) {
                    await handleMangaPollVote(
                        Bot,
                        update,
                        async (key) => {
                            if (!key?.remoteJid || !key?.id) return undefined
                            const jid = jidNormalizedUser(key.remoteJid)
                            const msg = await store.loadMessage(jid, key.id)
                            return msg?.message || undefined
                        }
                    )
                }
            })
        } catch (err) {
            console.error('Error in messages.update:', err?.message || err)
        }
    })

    // Add these event handlers for better functionality
    Bot.decodeJid = (jid) => {
        if (!jid) return jid
        if (/:\d+@/gi.test(jid)) {
            let decode = jidDecode(jid) || {}
            return decode.user && decode.server && decode.user + '@' + decode.server || jid
        } else return jid
    }

    Bot.ev.on('contacts.update', update => {
        for (let contact of update) {
            let id = Bot.decodeJid(contact.id)
            if (store && store.contacts) store.contacts[id] = { id, name: contact.notify }
        }
    })

    Bot.getName = (jid, withoutContact = false) => {
        id = Bot.decodeJid(jid)
        withoutContact = Bot.withoutContact || withoutContact
        let v
        if (id.endsWith("@g.us")) return new Promise(async (resolve) => {
            v = store.contacts[id] || {}
            if (!(v.name || v.subject)) v = Bot.groupMetadata(id) || {}
            resolve(v.name || v.subject || PhoneNumber('+' + id.replace('@s.whatsapp.net', '')).getNumber('international'))
        })
        else v = id === '0@s.whatsapp.net' ? {
            id,
            name: 'WhatsApp'
        } : id === Bot.decodeJid(Bot.user.id) ?
            Bot.user :
            (store.contacts[id] || {})
        return (withoutContact ? '' : v.name) || v.subject || v.verifiedName || PhoneNumber('+' + jid.replace('@s.whatsapp.net', '')).getNumber('international')
    }

    Bot.public = true

    Bot.serializeM = (m) => smsg(Bot, m, store)


    async function issuePairingCode() {
        if (!pairingCodeEnabled || state.creds.registered || pairingCodeRequested.has(botId)) return
        if (useMobile) throw new Error('Cannot use pairing code with mobile api')

        console.log(chalk.cyan(`[DEBUG WA:${botId}] Profile Data: botId=${profile.botId}, pairingNumber=${profile.pairingNumber}, ownerNumber=${profile.ownerNumber}, globalPhone=${global.phoneNumber}`));

        const ownerFromFile = Array.isArray(owner) ? owner[0] : owner
        const configuredPairNumber =
            profile.pairingNumber ||
            profile.ownerNumber ||
            global.phoneNumber ||
            settings.ownerNumber ||
            ownerFromFile ||
            phoneNumber ||
            process.env.PAIR_NUMBER ||
            process.env.PAIRING_NUMBER ||
            ''

        const pairNumber = String(configuredPairNumber).replace(/[^0-9]/g, '')

        if (!pairNumber) {
            console.log(chalk.yellow(`[WA:${botId}] No pairing number found. Skipping pairing code until ownerNumber is configured for this bot.`))
            return
        }

        const pn = require('awesome-phonenumber')
        if (!pn('+' + pairNumber).isValid()) {
            console.log(chalk.red(`[WA:${botId}] Invalid phone number for pairing. Configure ownerNumber with a full international number.`))
            return
        }
        pairingCodeRequested.add(botId)

        try {
            // Keep the wait short: some accounts close the pairing transport
            // quickly, and a long delay can prevent any code from being issued.
            await delay(500)
            let code = await Bot.requestPairingCode(pairNumber)
            code = code?.match(/.{1,4}/g)?.join("-") || code
            console.log(chalk.black(chalk.bgGreen(`[WA:${botId}] Pairing target : `)), chalk.black(chalk.white(pairNumber)))
            console.log(chalk.black(chalk.bgGreen(`[WA:${botId}] Your Pairing Code : `)), chalk.black(chalk.white(code)))
            console.log(chalk.yellow(`\nPlease enter this code in your WhatsApp app:\n1. Open WhatsApp\n2. Go to Settings > Linked Devices\n3. Tap "Link a Device"\n4. Enter the code shown above`))
        } catch (error) {
            pairingCodeRequested.delete(botId)
            console.error('Error requesting pairing code:', error)
            console.log(chalk.red('Failed to get pairing code. Please check your phone number and try again.'))
        }
    }

    // Connection handling
    Bot.ev.on('connection.update', async (s) => {
        const { connection, lastDisconnect } = s
        if (s?.qr && pairingMode === 'qr' && !state.creds.registered) {
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(s.qr)}`
            logWithDedupe(
                `wa-qr-${botId}`,
                chalk.green(`[WA:${botId}] QR ready: ${qrUrl}`),
                3000
            )
            if (qrTerminal && typeof qrTerminal.generate === 'function') {
                try {
                    qrTerminal.generate(s.qr, { small: true }, (qrText) => {
                        const normalizedQrText = String(qrText || '').replace(/\r/g, '')
                        const qrFilePath = path.join(process.cwd(), 'tmp', `${botId}-qr.txt`)
                        const qrPngPath = path.join(process.cwd(), 'tmp', `${botId}-qr.png`)
                        try {
                            fs.mkdirSync(path.dirname(qrFilePath), { recursive: true })
                            fs.writeFileSync(qrFilePath, `${normalizedQrText}\n`, 'utf8')
                            originalConsoleLog(chalk.green(`[WA:${botId}] QR file saved: ${qrFilePath}`))
                        } catch (fileErr) {
                            console.error(`Failed to save QR file for ${botId}:`, fileErr?.message || fileErr)
                        }
                        if (qrCodeImage && typeof qrCodeImage.toFile === 'function') {
                            qrCodeImage.toFile(qrPngPath, s.qr, {
                                type: 'png',
                                margin: 2,
                                scale: 8,
                                errorCorrectionLevel: 'M'
                            }).then(() => {
                                originalConsoleLog(chalk.green(`[WA:${botId}] QR image saved: ${qrPngPath}`))
                            }).catch((pngErr) => {
                                console.error(`Failed to save QR PNG for ${botId}:`, pngErr?.message || pngErr)
                            })
                        }
                    })
                } catch (qrErr) {
                    console.error(`Failed to render terminal QR for ${botId}:`, qrErr?.message || qrErr)
                }
            }
        }
        if (connection) {
            logWithDedupe(`wa-connection-${botId}-${connection}`, chalk.blue(`[WA:${botId}] connection.update => ${connection}`), 4000)
        }
        if (connection === 'connecting' && pairingCodeEnabled && !state.creds.registered) {
            issuePairingCode().catch((error) => {
                console.error('Error starting pairing flow:', error?.message || error)
            })
        }
        if (connection == "open") {
            const reconnectTimer = reconnectTimers.get(botId)
            if (reconnectTimer) {
                clearTimeout(reconnectTimer)
                reconnectTimers.delete(botId)
            }
            if (!state.creds.registered) {
                await issuePairingCode()
                return
            }
            console.log(`🌿Connected to => ` + JSON.stringify(Bot.user, null, 2))

            const botNumber = Bot.user.id.split(':')[0] + '@s.whatsapp.net';
            await Bot.sendMessage(botNumber, {
                text: `*Bot Connected Successfully!*\n\n⏰ Time: ${new Date().toLocaleString()}\n✅ Status: Online and Ready!`
            });

            await delay(800)
            printStartupCard(profile, Bot.user, owner, version)
            activeBots.set(botId, Bot)
            
            // Sync profiles from MongoDB on startup
            const { syncFromMongo } = require('./lib/mongoStore');
            syncFromMongo(true, botId).catch(err => console.error('[mongo] initial sync failed:', err));

            // Restore any in-progress TOD game timers after reconnect
            const { restoreGameTimers, startStaleCleanup } = require('./commands/games/truthordare');
            restoreGameTimers(Bot).catch(e => console.error('[TOD] restoreGameTimers error:', e));
            startStaleCleanup(Bot);
        }
        if (connection === 'close') {
            if (liveSockets.get(botId) === Bot) {
                liveSockets.delete(botId)
            }
            if (activeBots.get(botId) === Bot) {
                activeBots.delete(botId)
            }
            pairingCodeRequested.delete(botId)
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const reason = lastDisconnect?.error?.message || 'unknown'
            const isRegistered = Boolean(state.creds.registered)
            logWithDedupe(
                `wa-close-${botId}-${statusCode || 'na'}-${reason}`,
                chalk.red(`[WA:${botId}] connection closed. statusCode=${statusCode || 'n/a'} reason=${reason}`),
                15000
            )
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                try {
                    // During pairing, deleting the auth directory on a transient 401
                    // destroys the ephemeral state the phone still needs to complete
                    // the link. Only wipe auth once a registered session is actually
                    // logged out or invalidated.
                    if (isRegistered && (statusCode === DisconnectReason.loggedOut || statusCode === 401)) {
                        rmSync(profile.sessionDir || path.join(process.cwd(), 'session', botId), { recursive: true, force: true })
                    }
                } catch { }
                logWithDedupe(
                    `wa-auth-failure-${botId}-${statusCode || 'na'}-${isRegistered ? 'registered' : 'pairing'}`,
                    chalk.red(
                        isRegistered
                            ? `WhatsApp auth/session failure detected (${statusCode || 'n/a'}). Re-authenticate manually. Auto-reconnect paused.`
                            : `WhatsApp pairing session closed early (${statusCode || 'n/a'}). Keeping auth state so you can retry with a fresh code.`
                    ),
                    30000
                )
                if (!isRegistered) {
                    logWithDedupe(
                        'wa-pairing-wait',
                        chalk.yellow('[WA] Pairing session closed before registration completed. Enter the latest pairing code and restart manually if needed.'),
                        10000
                    )
                    return
                }
            } else {
                if (!state.creds.registered) {
                    if (pairingMode === 'qr') {
                        if (!reconnectTimers.has(botId)) {
                            logWithDedupe(
                                `wa-qr-reconnect-${botId}`,
                                chalk.yellow(`[WA:${botId}] QR session expired, refreshing in 15s...`),
                                3000
                            )
                            const reconnectTimer = setTimeout(() => {
                                reconnectTimers.delete(botId)
                                startBot(profile).catch((error) => {
                                    console.error('QR reconnect error:', error?.message || error)
                                })
                            }, 15000)
                            reconnectTimers.set(botId, reconnectTimer)
                        }
                        return
                    }
                    logWithDedupe(
                        'wa-pairing-wait',
                        chalk.yellow('[WA] Pairing session closed before registration completed. Use the last pairing code and restart manually if needed.'),
                        10000
                    )
                    return
                }
                if (!reconnectTimers.has(botId)) {
                    logWithDedupe(`wa-reconnect-scheduled-${botId}`, chalk.yellow(`[WA:${botId}] reconnecting in 5s...`), 5000)
                    const reconnectTimer = setTimeout(() => {
                        reconnectTimers.delete(botId)
                        startBot(profile).catch((error) => {
                            console.error('Reconnect error:', error?.message || error)
                        })
                    }, 5000)
                    reconnectTimers.set(botId, reconnectTimer)
                }
            }
        }
    })

    Bot.ev.on('creds.update', saveCreds)

    Bot.ev.on('group-participants.update', async (update) => {
        await runWithBotContext({ bot: Bot, profile }, async () => {
            await mainHandlers.handleGroupParticipantUpdate(Bot, update);
        });
    });

    Bot.ev.on('status.update', async (status) => {
        await runWithBotContext({ bot: Bot, profile }, async () => {
            await mainHandlers.handleStatus(Bot, status);
        });
    });

    Bot.ev.on('messages.reaction', async (status) => {
        await runWithBotContext({ bot: Bot, profile }, async () => {
            await mainHandlers.handleStatus(Bot, status);
        });
    });

    return Bot
    } finally {
        bootInProgress.delete(botId)
    }
}

async function startAllBots() {
    const profiles = loadBotProfiles(settings)
    if (!profiles.length) {
        throw new Error('No bot profiles were found to start.')
    }

    await Promise.all(profiles.map(async (profile) => {
        try {
            await startBot(profile)
        } catch (error) {
            console.error(`Fatal error starting bot ${profile.botId}:`, error)
        }
    }))
}

// Start the bots with error handling
startAllBots().catch(error => {
    console.error('Fatal error:', error)
    process.exit(1)
})

process.on('uncaughtException', (err) => {
    const errorMsg = err?.message?.toLowerCase() || err?.stack?.toLowerCase() || '';
    const isSessionError = (
        (errorMsg.includes('session error') && errorMsg.includes('bad mac')) ||
        errorMsg.includes('failed to decrypt message with any known session') ||
        (errorMsg.includes('bad mac') && (errorMsg.includes('session') || errorMsg.includes('decrypt'))) || errorMsg.includes('messagecountererror')
    );
    
    // Only log if it's not a session/decryption error
    if (!isSessionError) {
        console.error('Uncaught Exception:', err)
    }
    // Silently ignore session-related errors to prevent spam
})

process.on('unhandledRejection', (err) => {
    const errorMsg = err?.message?.toLowerCase() || err?.stack?.toLowerCase() || '';
    const isSessionError = (
        (errorMsg.includes('session error') && errorMsg.includes('bad mac')) ||
        errorMsg.includes('failed to decrypt message with any known session') ||
        (errorMsg.includes('bad mac') && (errorMsg.includes('session') || errorMsg.includes('decrypt'))) || errorMsg.includes('messagecountererror')
    );
    
    // Only log if it's not a session/decryption error
    if (!isSessionError) {
        console.error('Unhandled Rejection:', err)
    }
    // Silently ignore session-related errors to prevent spam
})
