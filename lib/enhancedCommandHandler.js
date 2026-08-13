const fs = require('fs');
const path = require('path');
const { hasPermission, PERMISSION_LEVELS } = require('./permissionMiddleware');
const { isGamblingCommand, isGamblingEnabled, sendGamblingLockedMessage } = require('./gamblingAccess');
const chalk = require('../lib/chalkSafe');

/**
 * Enhanced Command Handler with Permission System
 * Wraps commands with permission checks and error handling
 */

const commands = new Map();

/**
 * Pre-parses function parameter names at load time to avoid regex overhead at runtime.
 */
function parseParamNames(func) {
    if (typeof func !== 'function') return [];
    const fnStr = func.toString();
    const match = fnStr.match(/(?:function\s*.*?\(([^)]*)\))|(?:async\s*(?:\([^)]*\)|[^\s=]+)\s*=>)/) 
        || fnStr.match(/\(([^)]*)\)/);
    
    if (!match || !match[1]) return ['sock', 'chatId', 'message', 'senderId', 'args', 'options'];
    
    const rawParams = match[1].trim();
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
            case 'isOwner': return Boolean(ctx.isOwner);
            case 'isMod': return Boolean(ctx.isMod);
            case 'text': return ctx.userMessage || ctx.rawText || '';
            case 'options': return ctx.options || {};
            case 'match': return commandMatch;
            default: return ctx[p];
        }
    });
}

/**
 * Wrap execute function with permission checks and error handling
 */
function wrapExecute(func, permissionLevel = PERMISSION_LEVELS.USER) {
    const paramNames = parseParamNames(func);
    
    return async function(ctx) {
        try {
            const commandKey = String(ctx.commandKey || '').toLowerCase();
            if (isGamblingCommand(commandKey)) {
                const allowed = await isGamblingEnabled(ctx.chatId);
                if (!allowed) {
                    await sendGamblingLockedMessage(ctx.sock, ctx.chatId, ctx.message); // FIXED: centralized gambling group gate
                    return;
                }
            }
            // Permission check
            if (permissionLevel !== PERMISSION_LEVELS.USER) {
                const hasAccess = await hasPermission(ctx.sock, ctx.chatId, ctx.senderId, permissionLevel);
                if (!hasAccess) {
                    try {
                        await ctx.sock.sendMessage(ctx.chatId, {
                            text: '❌ You do not have permission to use this command.'
                        }, ctx.message ? { quoted: ctx.message } : {});
                    } catch (error) {
                        console.error('[CommandHandler] Error sending permission denied message:', error.message);
                    }
                    return;
                }
            }
            
            // Execute command
            return await func(...resolveArgs(paramNames, ctx));
        } catch (error) {
            const ts = new Date().toLocaleTimeString();
            process.stdout.write(chalk.red(`\n╔══ ERROR ══ ${ts}\n║ `) + chalk.white((error?.message || error) + '\n') + chalk.red(`╚${'═'.repeat(30)}\n\n`));
            
            try {
                if (ctx?.sock?.sendMessage && ctx?.chatId) {
                    await ctx.sock.sendMessage(ctx.chatId, {
                        text: '❌ An error occurred while executing this command.'
                    }, ctx.message ? { quoted: ctx.message } : {});
                }
            } catch (msgError) {
                console.error('[CommandHandler] Error sending error message:', msgError.message);
            }
        }
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
                
                // Determine permission level from command metadata
                const permissionLevel = cmd.permission || PERMISSION_LEVELS.USER;
                
                if (Array.isArray(cmd)) {
                    for (const sub of cmd) {
                        if (sub && sub.name && typeof sub.execute === 'function') {
                            const key = sub.name.startsWith('.') ? sub.name.toLowerCase() : `.${sub.name.toLowerCase()}`;
                            sub.execute = wrapExecute(sub.execute, sub.permission || permissionLevel);
                            commands.set(key, sub);
                            registerAliases(sub, sub);
                        }
                    }
                } else if (cmd && cmd.name && typeof cmd.execute === 'function') {
                    const key = cmd.name.startsWith('.') ? cmd.name.toLowerCase() : `.${cmd.name.toLowerCase()}`;
                    cmd.execute = wrapExecute(cmd.execute, cmd.permission || permissionLevel);
                    commands.set(key, cmd);
                    registerAliases(cmd, cmd);
                } else if (cmd && typeof cmd === 'object') {
                    const baseName = path.basename(file, '.js').toLowerCase();
                    let registeredBasename = false;

                    Object.entries(cmd).forEach(([k, v]) => {
                        if (typeof v === 'function') {
                            const match = k.match(/^(?:handle)?([A-Za-z0-9_]+)Command$/);
                            const cname = match ? match[1].toLowerCase() : k.toLowerCase();
                            
                            const wrapped = wrapExecute(v, permissionLevel);
                            commands.set('.' + cname, {
                                name: '.' + cname,
                                execute: wrapped,
                                permission: permissionLevel
                            });

                            if (!registeredBasename && (k === 'start' + baseName.charAt(0).toUpperCase() + baseName.slice(1) || k === baseName + 'Command' || match || ['withdraw', 'deposit'].includes(k))) {
                                commands.set('.' + baseName, {
                                    name: '.' + baseName,
                                    execute: wrapped,
                                    permission: permissionLevel
                                });
                                registeredBasename = true;
                            }
                        }
                    });
                } else if (typeof cmd === 'function') {
                    const baseName = path.basename(file, '.js').toLowerCase();
                    commands.set('.' + baseName, {
                        name: '.' + baseName,
                        execute: wrapExecute(cmd, permissionLevel),
                        permission: permissionLevel
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
                        },
                        permission: PERMISSION_LEVELS.USER
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
    process.stdout.write(chalk.green(`  ✔ ${commands.size} commands loaded\n`));
}

module.exports = commands;
