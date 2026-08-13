const fs = require('fs');
const path = require('path');
const axiosModule = require('axios');

const axios = axiosModule.default || axiosModule;

async function checkUrlHealth(url) {
    try {
        const startTime = Date.now();
        const response = await axios.get(url, { timeout: 5000 }); // FIXED: axios shim does not expose head()
        const duration = Date.now() - startTime;
        return {
            url,
            status: 'Alive',
            code: response.status,
            latency: `${duration}ms`
        };
    } catch (error) {
        return {
            url,
            status: 'Dead',
            error: error.message || 'Unknown error'
        };
    }
}

function normalizeHealthUrl(url = '') {
    return String(url || '')
        .replace(/\$\{[^}]+\}/g, '') // FIXED: strip template placeholders so cmdhealth checks the real base URL
        .replace(/[)\],;'"`]+$/g, '')
        .trim();
}

function extractUrls(content = '') {
    const regex = /https?:\/\/[^\s'"`()<>]+/g;
    const matches = content.match(regex) || [];
    const urls = [];
    for (const match of matches) {
        const normalized = normalizeHealthUrl(match);
        if (normalized && !urls.includes(normalized)) {
            urls.push(normalized);
        }
    }
    return urls;
}

function findCommandFile(cmdName) {
    const commandsDir = path.join(process.cwd(), 'commands');
    const walk = (dir) => {
        let results = [];
        const list = fs.readdirSync(dir);
        list.forEach((file) => {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            if (stat && stat.isDirectory()) {
                results = results.concat(walk(fullPath));
            } else if (file.endsWith('.js')) {
                results.push(fullPath);
            }
        });
        return results;
    };

    const files = walk(commandsDir);
    for (const file of files) {
        try {
            const cmd = require(file);
            const name = String(cmd.name || '').toLowerCase();
            const aliases = [cmd.alias, cmd.aliases]
                .flat()
                .filter(Boolean)
                .map((value) => String(value).toLowerCase()); // FIXED: support both alias and aliases arrays

            if (name === cmdName.toLowerCase() || aliases.includes(cmdName.toLowerCase()) || path.basename(file, '.js').toLowerCase() === cmdName.toLowerCase()) {
                return file;
            }
        } catch {
            if (path.basename(file, '.js').toLowerCase() === cmdName.toLowerCase()) {
                return file;
            }
        }
    }
    return null;
}

module.exports = {
    name: 'cmdhealth',
    alias: ['health', 'isalive', 'isdead'],
    permissionLevel: 'sudo',
    async execute(ctx) {
        const { sock, chatId, message, args } = ctx;
        const cmdName = args[0];

        if (!cmdName) {
            return sock.sendMessage(chatId, { text: 'Usage: .cmdhealth <command_name>' }, { quoted: message });
        }

        const filePath = findCommandFile(cmdName);
        if (!filePath) {
            return sock.sendMessage(chatId, { text: `Command "${cmdName}" not found.` }, { quoted: message });
        }

        const relativePath = path.relative(process.cwd(), filePath);
        let report = `*CMD HEALTH REPORT*\n\n`;
        report += `*Command:* ${cmdName}\n`;
        report += `*File:* ${relativePath}\n`;

        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const urls = extractUrls(content);

            if (urls.length === 0) {
                report += `*APIs:* No external APIs detected in code.\n`;
            } else {
                report += `*Detected APIs:* ${urls.length}\n\n`;
                for (const url of urls) {
                    const health = await checkUrlHealth(url);
                    if (health.status === 'Alive') {
                        report += `✅ *${health.status}* [${health.code}]\n${url}\n⏱️ ${health.latency}\n\n`;
                    } else {
                        report += `❌ *${health.status}*\n${url}\n⚠️ ${health.error}\n\n`;
                    }
                }
            }

            try {
                require(filePath);
                report += `*Syntax:* ✅ Valid\n`;
            } catch (err) {
                report += `*Syntax:* ❌ Error\n⚠️ ${err.message}\n`;
            }

        } catch (error) {
            report += `❌ *Error reading file:* ${error.message}`;
        }

        await sock.sendMessage(chatId, { text: report }, { quoted: message });
    }
};
