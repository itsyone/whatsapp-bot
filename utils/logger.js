function summarizeValue(value, depth = 0) {
    if (value === null || value === undefined) return String(value);
    if (typeof value === 'string') {
        const clean = value.replace(/\s+/g, ' ').trim();
        return clean.length > 180 ? `${clean.slice(0, 177)}...` : clean;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Buffer.isBuffer(value)) return `<Buffer ${value.length}b>`;
    if (value instanceof Error) return `${value.name || 'Error'}: ${value.message || 'unknown error'}`;
    if (Array.isArray(value)) {
        if (depth >= 1) return `[Array(${value.length})]`;
        const preview = value.slice(0, 4).map((item) => summarizeValue(item, depth + 1)).join(', ');
        return `[${preview}${value.length > 4 ? ', ...' : ''}]`;
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value);
        if (depth >= 1) return `{${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', ...' : ''}}`;
        const preview = keys.slice(0, 6).map((key) => `${key}: ${summarizeValue(value[key], depth + 1)}`).join(', ');
        return `{ ${preview}${keys.length > 6 ? ', ...' : ''} }`;
    }
    return String(value);
}

function formatLogLine(args = []) {
    return args
        .map((arg) => summarizeValue(arg))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeLogText(value = '') {
    return String(value || '')
        .replace(/\r/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function prettifyLogText(text = '') {
    const clean = normalizeLogText(text);
    if (!clean) return '';

    if (/^\[WA\] connection\.update => connecting$/i.test(clean)) return '[WA] Connecting...';
    if (/^\[WA\] connection\.update => open$/i.test(clean)) return '[WA] Connected';
    if (/^\[WA\] connection\.update => close$/i.test(clean)) return '[WA] Disconnected';

    const commandMatch = clean.match(/command used in (group|private):\s*(.+)$/i);
    if (commandMatch) {
        const scope = commandMatch[1].toLowerCase() === 'group' ? 'group' : 'pm';
        return `[CMD] ${scope} ${commandMatch[2]}`;
    }

    if (/connected to =>/i.test(clean)) {
        return clean.replace(/^.*connected to =>\s*/i, '[WA] Account ');
    }

    if (/^Using Baileys version:/i.test(clean)) {
        return clean.replace(/^Using Baileys version:\s*/i, '[SYS] Baileys ');
    }

    if (/^Unhandled Rejection:/i.test(clean)) {
        return clean.replace(/^Unhandled Rejection:\s*/i, '[ERR] ');
    }

    if (/^Uncaught Exception:/i.test(clean)) {
        return clean.replace(/^Uncaught Exception:\s*/i, '[ERR] ');
    }

    if (/^Fatal error:/i.test(clean)) {
        return clean.replace(/^Fatal error:\s*/i, '[ERR] Fatal ');
    }

    return clean;
}

function isRawPinoJson(msg) {
    if (typeof msg !== 'string') return false;
    return msg.trim().startsWith('{') && msg.includes('"level"') && msg.includes('"hostname"');
}

function shouldSuppressNoisyText(text = '') {
    const lower = normalizeLogText(text).toLowerCase();
    return (
        lower.includes('error in isadmin: error: rate-overlimit') ||
        lower.includes('error in quote command: error: rate-overlimit') ||
        lower.includes('[sticker] error: error: rate-overlimit') ||
        lower.includes('error in handlemessages: error: rate-overlimit') ||
        lower.includes('stack trace: error: rate-overlimit') ||
        lower.includes('warning: using old cookie format') ||
        lower.includes('warning: could not parse decipher function') ||
        lower.includes('warning: could not parse n transform function') ||
        lower.includes('decrypted message with closed session.') ||
        lower.includes('typeerror: terminated') ||
        lower.includes('warning: closing file descriptor') ||
        lower.includes('[dep0137] deprecationwarning: closing a filehandle object on garbage collection is deprecated') ||
        lower.includes('closing session: sessionentry') ||
        lower.includes('removing old closed session: sessionentry') ||
        lower.includes('closing open session') ||
        lower.includes('sessionentry {') ||
        lower.includes('indexinfo: {') ||
        lower.includes('pendingprekey: {') ||
        lower.includes('currentratchet: {') ||
        lower.includes('ephemeralkeypair: {') ||
        lower.includes('basekey: <buffer') ||
        lower.includes('remoteidentitykey: <buffer') ||
        lower.includes('rootkey: <buffer') ||
        lower.includes('pubkey: <buffer') ||
        lower.includes('privkey: <buffer') ||
        lower.includes('got history notification') ||
        lower.includes('offline preview received') ||
        lower.includes('handled 1 offline messages/notifications') ||
        lower.includes('connection is now awaitinginitialsync') ||
        lower.includes('history sync is enabled') ||
        lower.includes('opened connection to wa') ||
        lower.includes('own lid session created successfully') ||
        lower.includes('pre-keys found on server') ||
        lower.includes('current prekey id:') ||
        lower.includes('prekey validation passed') ||
        lower.includes('timeout in awaitinginitialsync') ||
        lower.includes('identity key changed or new contact') ||
        lower.includes('failed to sync state from version') ||
        lower.includes('resyncing regular_low from v0') ||
        lower.includes('restored state of regular_low from snapshot') ||
        lower.includes('archive setting updated =>') ||
        lower.includes('transaction failed, rolling back') ||
        lower.includes('sent retry receipt') ||
        lower.includes('failed to decrypt message') ||
        lower.includes('"msg":"connected to wa"') ||
        lower.includes('"msg":"logging in..."') ||
        lower.includes('"msg":"unexpected error in \'init queries\'"') ||
        lower.includes('"msg":"identity changed"') ||
        lower.includes('"msg":"device removed"') ||
        lower.includes('"msg":"opened connection to wa"') ||
        lower.includes('"msg":"offline preview received"') ||
        lower.includes('"msg":"handled ') ||
        lower.includes('"msg":"connection is now awaitinginitialsync') ||
        lower.includes('"msg":"history sync is enabled') ||
        lower.includes('"msg":"own lid session created successfully"') ||
        lower.includes('"msg":"prekey validation passed') ||
        lower.includes('"msg":"current prekey id:') ||
        lower.includes('"msg":"pre-keys found on server"') ||
        lower.includes('no name present') ||
        lower.includes('printqrinterminal') ||
        lower.includes('buffer timeout') ||
        lower.includes('timed out waiting') ||
        lower.includes('uploading prekeys') ||
        lower.includes('uploading pre-keys') ||
        lower.includes('uploaded pre-keys') ||
        lower.includes('injecting new app state') ||
        lower.includes('not logged in, attempting registration')
    );
}

function shouldSuppressNoisyLog(args = []) {
    return shouldSuppressNoisyText(formatLogLine(args));
}

function createFilteredWrite(originalWrite) {
    let suppressSessionBlock = false;
    let sessionBraceDepth = 0;

    return function filteredWrite(chunk, encoding, callback) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8') : String(chunk ?? '');
        const pieces = text.split(/\n/);
        let wrote = false;

        for (let index = 0; index < pieces.length; index += 1) {
            const piece = pieces[index];
            const isLast = index === pieces.length - 1;
            const normalized = normalizeLogText(piece);

            if (suppressSessionBlock) {
                const openCount = (normalized.match(/\{/g) || []).length;
                const closeCount = (normalized.match(/\}/g) || []).length;
                sessionBraceDepth += openCount - closeCount;
                if (sessionBraceDepth <= 0) {
                    suppressSessionBlock = false;
                    sessionBraceDepth = 0;
                }
                continue;
            }

            if (!normalized) {
                if (!isLast) {
                    originalWrite.call(this, '\n', encoding);
                    wrote = true;
                }
                continue;
            }

            if (
                normalized.toLowerCase().startsWith('closing session: sessionentry') ||
                normalized.toLowerCase().startsWith('removing old closed session: sessionentry')
            ) {
                suppressSessionBlock = true;
                sessionBraceDepth = (normalized.match(/\{/g) || []).length - (normalized.match(/\}/g) || []).length;
                if (sessionBraceDepth <= 0) {
                    sessionBraceDepth = 1;
                }
                continue;
            }

            if (shouldSuppressNoisyText(normalized)) {
                continue;
            }

            originalWrite.call(this, isLast ? `${normalized}` : `${normalized}\n`, encoding);
            wrote = true;
        }

        if (typeof callback === 'function') callback();
        return wrote || true;
    };
}

function installCompactConsole() {
    const original = {
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        stdoutWrite: process.stdout.write.bind(process.stdout),
        stderrWrite: process.stderr.write.bind(process.stderr)
    };

    const write = (level) => (...args) => {
        const line = formatLogLine(args);
        
        // SUPPRESS 100%
        if (typeof line === 'string') {
            const lower = line.toLowerCase();
            if (
                lower.includes('"level":30') ||
                lower.includes('"level":40') ||
                lower.includes('"level":50') ||
                lower.includes('"hostname"') ||
                lower.includes('no name present') ||
                lower.includes('buffer timeout') ||
                lower.includes('timed out waiting') ||
                lower.includes('printqrinterminal') ||
                lower.includes('uploading prekeys') ||
                lower.includes('uploading pre-keys') ||
                lower.includes('uploaded pre-keys') ||
                lower.includes('injecting new app state') ||
                lower.includes('not logged in, attempting') ||
                lower.includes('garbage collection completed') ||
                lower.includes('auto-flushing') ||
                lower.includes('will not send message')
            ) {
                return;
            }
        }
        
        if (isRawPinoJson(line)) return;
        if (shouldSuppressNoisyLog(args)) return;
        const prettified = prettifyLogText(line);
        if (!prettified) return;
        original[level](prettified);
    };

    console.log = write('log');
    console.warn = write('warn');
    console.error = write('error');
    process.stdout.write = createFilteredWrite(original.stdoutWrite);
    process.stderr.write = createFilteredWrite(original.stderrWrite);

    return original;
}

module.exports = {
    formatLogLine,
    prettifyLogText,
    installCompactConsole,
    shouldSuppressNoisyLog
};
