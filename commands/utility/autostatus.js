const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '../../data/autoStatus.json');

if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({
        enabled: false,
        reactOn: false
    }));
}

async function autoStatusCommand(sock, chatId, msg, args) {
    try {
        if (!msg.key.fromMe) {
            await sock.sendMessage(chatId, {
                text: 'This command can only be used by the owner!'
            });
            return;
        }

        let config = JSON.parse(fs.readFileSync(configPath));

        if (!args || args.length === 0) {
            const status = config.enabled ? 'enabled' : 'disabled';
            const reactStatus = config.reactOn ? 'enabled' : 'disabled';
            await sock.sendMessage(chatId, {
                text: `Auto Status Settings\n\nAuto Status View: ${status}\nStatus Reactions: ${reactStatus}\n\nCommands:\n.autostatus on - Enable auto status view\n.autostatus off - Disable auto status view\n.autostatus react on - Enable status reactions\n.autostatus react off - Disable status reactions`
            });
            return;
        }

        const command = args[0].toLowerCase();

        if (command === 'on') {
            config.enabled = true;
            fs.writeFileSync(configPath, JSON.stringify(config));
            await sock.sendMessage(chatId, {
                text: 'Auto status view has been enabled.\nBot will now automatically view all contact statuses.'
            });
        } else if (command === 'off') {
            config.enabled = false;
            fs.writeFileSync(configPath, JSON.stringify(config));
            await sock.sendMessage(chatId, {
                text: 'Auto status view has been disabled.\nBot will no longer automatically view statuses.'
            });
        } else if (command === 'react') {
            if (!args[1]) {
                await sock.sendMessage(chatId, {
                    text: 'Please specify on/off for reactions.\nUse: .autostatus react on/off'
                });
                return;
            }

            const reactCommand = args[1].toLowerCase();
            if (reactCommand === 'on') {
                config.reactOn = true;
                fs.writeFileSync(configPath, JSON.stringify(config));
                await sock.sendMessage(chatId, {
                    text: 'Status reactions have been enabled.\nBot will now react to status updates.'
                });
            } else if (reactCommand === 'off') {
                config.reactOn = false;
                fs.writeFileSync(configPath, JSON.stringify(config));
                await sock.sendMessage(chatId, {
                    text: 'Status reactions have been disabled.\nBot will no longer react to status updates.'
                });
            } else {
                await sock.sendMessage(chatId, {
                    text: 'Invalid reaction command. Use: .autostatus react on/off'
                });
            }
        } else {
            await sock.sendMessage(chatId, {
                text: 'Invalid command. Use:\n.autostatus on/off - Enable/disable auto status view\n.autostatus react on/off - Enable/disable status reactions'
            });
        }
    } catch (error) {
        console.error('Error in autostatus command:', error);
        await sock.sendMessage(chatId, {
            text: 'Error occurred while managing auto status.\n' + error.message
        });
    }
}

function isAutoStatusEnabled() {
    try {
        const config = JSON.parse(fs.readFileSync(configPath));
        return config.enabled;
    } catch (error) {
        console.error('Error checking auto status config:', error);
        return false;
    }
}

function isStatusReactionEnabled() {
    try {
        const config = JSON.parse(fs.readFileSync(configPath));
        return config.reactOn;
    } catch (error) {
        console.error('Error checking status reaction config:', error);
        return false;
    }
}

async function reactToStatus(sock, statusKey) {
    try {
        if (!isStatusReactionEnabled()) return;

        await sock.relayMessage(
            'status@broadcast',
            {
                reactionMessage: {
                    key: {
                        remoteJid: 'status@broadcast',
                        id: statusKey.id,
                        participant: statusKey.participant || statusKey.remoteJid,
                        fromMe: false
                    },
                    text: '💚'
                }
            },
            {
                messageId: statusKey.id,
                statusJidList: [statusKey.remoteJid, statusKey.participant || statusKey.remoteJid]
            }
        );
    } catch (error) {
        console.error('Error reacting to status:', error.message);
    }
}

async function handleStatusUpdate(sock, status) {
    try {
        if (!isAutoStatusEnabled()) return;

        await new Promise((resolve) => setTimeout(resolve, 1000));

        if (status.messages && status.messages.length > 0) {
            const msg = status.messages[0];
            if (msg.key && msg.key.remoteJid === 'status@broadcast') {
                try {
                    await sock.readMessages([msg.key]);
                    await reactToStatus(sock, msg.key);
                } catch (err) {
                    if (err.message?.includes('rate-overlimit')) {
                        await new Promise((resolve) => setTimeout(resolve, 2000));
                        await sock.readMessages([msg.key]);
                    } else {
                        throw err;
                    }
                }
                return;
            }
        }

        if (status.key && status.key.remoteJid === 'status@broadcast') {
            try {
                await sock.readMessages([status.key]);
                await reactToStatus(sock, status.key);
            } catch (err) {
                if (err.message?.includes('rate-overlimit')) {
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    await sock.readMessages([status.key]);
                } else {
                    throw err;
                }
            }
            return;
        }

        if (status.reaction && status.reaction.key.remoteJid === 'status@broadcast') {
            try {
                await sock.readMessages([status.reaction.key]);
                await reactToStatus(sock, status.reaction.key);
            } catch (err) {
                if (err.message?.includes('rate-overlimit')) {
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    await sock.readMessages([status.reaction.key]);
                } else {
                    throw err;
                }
            }
        }
    } catch (error) {
        console.error('Error in auto status view:', error.message);
    }
}

module.exports = {
    autoStatusCommand,
    handleStatusUpdate
};
