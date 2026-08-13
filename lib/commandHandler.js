const fs = require('fs');
const path = require('path');
const { hasPermission } = require('./permissionHandler');
const { isGamblingCommand, isGamblingEnabled, sendGamblingLockedMessage } = require('./gamblingAccess');

const commands = new Map();

/**
 * Pre-parses function parameter names at load time to avoid regex overhead at runtime.
 */
function parseParamNames(func) {
    if (typeof func !== 'function') return [];
    const fnStr = func.toString();
    const functionMatch = fnStr.match(/function\s*.*?\(([^)]*)\)/);
    const parenArrowMatch = fnStr.match(/async\s*\(([^)]*)\)\s*=>|\(([^)]*)\)\s*=>/);
    const singleArrowMatch = fnStr.match(/async\s+([^\s=()]+)\s*=>|([^\s=()]+)\s*=>/);
    const genericParenMatch = fnStr.match(/\(([^)]*)\)/);

    const rawParams = (
        functionMatch?.[1] ??
        parenArrowMatch?.[1] ??
        parenArrowMatch?.[2] ??
        singleArrowMatch?.[1] ??
        singleArrowMatch?.[2] ??
        genericParenMatch?.[1] ??
        ''
    ).trim();

    if (!rawParams) return ['sock', 'chatId', 'message', 'senderId', 'args', 'options'];

    // Handle destructuring ({ sock }) or single 'ctx' param (with possible default value)
    if (rawParams.startsWith('{') || rawParams.split(/[=,\s]/)[0].trim() === 'ctx') return ['__ctx__'];
    
    return rawParams.split(',').map(p => p.trim().split(/[=:\s]/)[0].trim()).filter(Boolean);
}

/**
 * Resolves arguments from context based on pre-parsed parameter names.
 */
function resolveArgs(paramNames, ctx) {
    if (paramNames.length === 1 && paramNames[0] === '__ctx__') return [ctx];

    const fullText = String(ctx.rawText || ctx.userMessage || '').trim();
    const commandMatch = fullText.replace(/^\S+/, '').trim();

    return paramNames.map(p => {
        switch (p) {
            case 'sock': return ctx.sock;
            case 'bot': return ctx.bot || ctx.sock;
            case 'profile': return ctx.profile || null;
            case 'chatId': return ctx.chatId;
            case 'message': 
            case 'm': return ctx.message;
            case 'senderId': return ctx.senderId;
            case 'userMessage': return ctx.userMessage;
            case 'rawText': return ctx.rawText;
            case 'args': return ctx.args;
            case 'mentionedJids': return ctx.mentionedJids || [];
            case 'isGroup': return ctx.chatId ? ctx.chatId.endsWith('@g.us') : false;
            case 'isSenderAdmin': return Boolean(ctx.isSenderAdmin);
            case 'isBotAdmin': return Boolean(ctx.isBotAdmin);
            case 'text': return ctx.userMessage || ctx.rawText || '';
            case 'options': return ctx.options || {};
            case 'match': return commandMatch;
            default: return ctx[p];
        }
    });
}

async function sendPermissionDenied(ctx) {
    if (!ctx?.sock?.sendMessage || !ctx?.chatId) return;
    await ctx.sock.sendMessage(
        ctx.chatId,
        { text: "You don't have permission to use this command." }, // FIXED: centralized permission reply
        ctx.message ? { quoted: ctx.message } : {}
    );
}

async function resolveGroupMetadata(ctx) {
    if (ctx.groupMetadata) return ctx.groupMetadata;
    if (!ctx.chatId?.endsWith?.('@g.us') || !ctx.sock?.groupMetadata) return null;

    try {
        ctx.groupMetadata = await ctx.sock.groupMetadata(ctx.chatId); // FIXED: lazy group metadata fetch
    } catch {
        ctx.groupMetadata = null;
    }
    return ctx.groupMetadata;
}

function wrapExecute(func, permissionLevel = null) {
    const paramNames = parseParamNames(func);
    return async function(ctx) {
        const commandKey = String(ctx.commandKey || '').toLowerCase();
        if (isGamblingCommand(commandKey)) {
            const allowed = await isGamblingEnabled(ctx.chatId);
            if (!allowed) {
                await sendGamblingLockedMessage(ctx.sock, ctx.chatId, ctx.message); // FIXED: centralized gambling group gate
                return;
            }
        }
        if (permissionLevel) {
            const metadata = permissionLevel === 'admin'
                ? await resolveGroupMetadata(ctx)
                : (ctx.groupMetadata || null); // FIXED: avoid unnecessary group metadata fetches for owner/sudo commands
            const allowed = await hasPermission(ctx.senderId || ctx.sender, permissionLevel, metadata);
            if (!allowed) {
                await sendPermissionDenied(ctx);
                return;
            }
        }
        return func(...resolveArgs(paramNames, ctx));
    };
}

function registerAliases(cmd, command) {
    const aliases = [
        ...(Array.isArray(cmd.alias) ? cmd.alias : cmd.alias ? [cmd.alias] : []),
        ...(Array.isArray(cmd.aliases) ? cmd.aliases : cmd.aliases ? [cmd.aliases] : [])
    ];

    for (const al of aliases) {
        const alKey = al.startsWith('.') ? al.toLowerCase() : `.${al.toLowerCase()}`;
        commands.set(alKey, command);
    }
}

function loadCommands(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            loadCommands(fullPath);
        } else if (file.endsWith('.js')) {
            try {
                const cmd = require(fullPath);
                if (Array.isArray(cmd)) {
                    for (const sub of cmd) {
                        if (sub && sub.name && typeof sub.execute === 'function') {
                            const key = sub.name.startsWith('.') ? sub.name.toLowerCase() : `.${sub.name.toLowerCase()}`;
                            sub.execute = wrapExecute(sub.execute, sub.permissionLevel);
                            commands.set(key, sub);
                            registerAliases(sub, sub);
                        }
                    }
                } else if (cmd && cmd.name && typeof cmd.execute === 'function') {
                    const key = cmd.name.startsWith('.') ? cmd.name.toLowerCase() : `.${cmd.name.toLowerCase()}`;
                    cmd.execute = wrapExecute(cmd.execute, cmd.permissionLevel);
                    commands.set(key, cmd);
                    registerAliases(cmd, cmd);
                } else if (cmd && typeof cmd === 'object') {
                    const baseName = path.basename(file, '.js').toLowerCase();
                    let registeredBasename = false;

                    Object.entries(cmd).forEach(([k, v]) => {
                        if (typeof v === 'function') {
                            const match = k.match(/^(?:handle)?([A-Za-z0-9_]+)Command$/);
                            const cname = match ? match[1].toLowerCase() : k.toLowerCase();
                            
                            const wrapped = wrapExecute(v);
                            commands.set('.' + cname, {
                                name: '.' + cname,
                                execute: wrapped
                            });

                            if (!registeredBasename && (k === 'start' + baseName.charAt(0).toUpperCase() + baseName.slice(1) || k === baseName + 'Command' || match || ['withdraw', 'deposit'].includes(k))) {
                                commands.set('.' + baseName, {
                                    name: '.' + baseName,
                                    execute: wrapped
                                });
                                registeredBasename = true;
                            }
                        }
                    });
                } else if (typeof cmd === 'function') {
                    const baseName = path.basename(file, '.js').toLowerCase();
                    commands.set('.' + baseName, {
                        name: '.' + baseName,
                        execute: wrapExecute(cmd)
                    });
                }
            } catch (err) {
                const text = String(err?.stack || err?.message || err || '').toLowerCase();
                if (text.includes('canvas.node') || text.includes("cannot find module 'canvas'") || text.includes('module did not self-register')) {
                    const baseName = path.basename(file, '.js').toLowerCase();
                    const featureName = baseName.charAt(0).toUpperCase() + baseName.slice(1);
                    commands.set('.' + baseName, {
                        name: '.' + baseName,
                        execute: async (ctx) => {
                            if (!ctx.sock || !ctx.chatId) return;
                            await ctx.sock.sendMessage(ctx.chatId, { text: `\`${featureName}\` is unavailable on this host because the canvas module failed to load.` }, ctx.message ? { quoted: ctx.message } : {});
                        }
                    });
                } else {
                    console.error(`[CommandHandler] Failed to load command ${file}:`, err?.message || err);
                }
            }
        }
    }
}

const rootCommandsDir = path.join(__dirname, '..', 'commands');
if (fs.existsSync(rootCommandsDir)) {
    loadCommands(rootCommandsDir);
    console.log(`[CommandHandler] 🟢 Successfully loaded ${commands.size} dynamic commands!`);
}

module.exports = commands;

