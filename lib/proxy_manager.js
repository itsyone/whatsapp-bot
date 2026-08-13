const axios = require('axios');
const fs = require('fs');
const path = require('path');

class ProxyManager {
    constructor() {
        this.sources = [
            'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=all',
            'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
            'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'
        ];
        this.userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ];
        this.cachePath = path.join(process.cwd(), 'proxies.json');
        this.workingProxies = this.loadCache();
        this.isRefreshing = false;
        
        if (this.workingProxies.length < 5) this.refreshPool();
    }

    loadCache() {
        try {
            if (fs.existsSync(this.cachePath)) {
                const data = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
                if (Date.now() - data.timestamp < 3600000) return data.proxies;
            }
        } catch (e) {}
        return [];
    }

    saveCache() {
        try {
            fs.writeFileSync(this.cachePath, JSON.stringify({
                timestamp: Date.now(),
                proxies: this.workingProxies.slice(0, 50)
            }));
        } catch (e) {}
    }

    async refreshPool() {
        if (this.isRefreshing) return;
        this.isRefreshing = true;
        try {
            const allRaw = [];
            for (const url of this.sources) {
                try {
                    const res = await axios.get(url, { timeout: 5000 });
                    allRaw.push(...res.data.split('\n').map(p => p.trim()).filter(p => p && p.includes(':')));
                } catch (e) {}
            }
            const candidates = [...new Set(allRaw)].sort(() => 0.5 - Math.random()).slice(0, 300);
            const results = await Promise.all(candidates.map(async (p) => {
                const [host, port] = p.split(':');
                try {
                    const start = Date.now();
                    await axios.get('https://yt2mp3.sc/', {
                        proxy: { host, port: parseInt(port) },
                        timeout: 3000,
                        headers: { 'User-Agent': this.userAgents[0] }
                    });
                    return { proxy: p, latency: Date.now() - start, success: true };
                } catch (e) { return { success: false }; }
            }));
            this.workingProxies = results.filter(r => r.success).sort((a, b) => a.latency - b.latency).map(r => r.proxy);
            this.saveCache();
        } finally { this.isRefreshing = false; }
    }

    async getFastestProxies(count = 10) {
        if (this.workingProxies.length < count) await this.refreshPool();
        return this.workingProxies.slice(0, count);
    }
}

module.exports = new ProxyManager();
