const { Readable } = require('stream');

/**
 * Robust URL builder that handles baseURL and query parameters correctly.
 */
function buildUrl(input, params, baseURL = null) {
    let finalUrl;
    
    // Handle baseURL resolution
    if (baseURL && !/^https?:\/\//i.test(input)) {
        try {
            // Standard Axios behavior: join baseURL and relative path
            const base = baseURL.endsWith('/') ? baseURL : baseURL + '/';
            const path = input.startsWith('/') ? input.substring(1) : input;
            finalUrl = new URL(path, base);
        } catch (e) {
            // Fallback for edge cases
            finalUrl = new URL(input);
        }
    } else {
        finalUrl = new URL(input);
    }

    // Append query parameters
    const entries = params && typeof params === 'object' ? Object.entries(params) : [];
    for (const [key, value] of entries) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
            for (const item of value) {
                finalUrl.searchParams.append(key, String(item));
            }
        } else {
            finalUrl.searchParams.append(key, String(value));
        }
    }

    return finalUrl.toString();
}

/**
 * Filter out null/undefined headers
 */
function normalizeHeaders(headers = {}) {
    const out = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (value === undefined || value === null) continue;
        out[key] = value;
    }
    return out;
}

/**
 * Create a standard Axios-compatible error
 */
function createError(message, response = null) {
    const error = new Error(message);
    if (response) {
        error.response = response;
        error.status = response.status;
    }
    error.isAxiosError = true;
    return error;
}

/**
 * Parse fetch response based on responseType and Content-Type
 */
async function parseResponse(res, responseType) {
    if (responseType === 'arraybuffer') {
        return Buffer.from(await res.arrayBuffer());
    }

    if (responseType === 'stream') {
        // Readable.fromWeb requires Node 16.5+
        return Readable.fromWeb ? Readable.fromWeb(res.body) : res.body;
    }

    const text = await res.text();
    if (responseType === 'text') {
        return text;
    }

    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }

    return text;
}

/**
 * Create a new Axios instance with merged configurations
 */
function createInstance(defaultConfig = {}) {
    const instance = async function(config) {
        // Standardize config input
        const userConfig = typeof config === 'string' ? { url: config } : { ...(config || {}) };
        
        // Merge configurations (shallow merge for most, deep for headers/params)
        const finalConfig = {
            ...defaultConfig,
            ...userConfig,
            headers: normalizeHeaders({
                ...(defaultConfig.headers || {}),
                ...(userConfig.headers || {})
            }),
            params: {
                ...(defaultConfig.params || {}),
                ...(userConfig.params || {})
            }
        };

        if (!finalConfig.url) {
            throw createError('axiosShim: missing url');
        }

        const method = String(finalConfig.method || 'get').toUpperCase();
        const url = buildUrl(finalConfig.url, finalConfig.params, finalConfig.baseURL);
        const headers = finalConfig.headers;

        // Special handling for FormData headers (standard Axios behavior)
        if (finalConfig.data && typeof finalConfig.data.getHeaders === 'function') {
            Object.assign(headers, normalizeHeaders(finalConfig.data.getHeaders()));
        }

        const controller = new AbortController();
        const timeout = Number(finalConfig.timeout || 0);
        const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;

        try {
            let body = finalConfig.data;
            
            // Auto-stringify JSON bodies
            if (body && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof URLSearchParams) && body.constructor.name !== 'FormData') {
                const hasContentType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
                if (!hasContentType) headers['Content-Type'] = 'application/json';
                body = JSON.stringify(body);
            }

            const res = await fetch(url, {
                method,
                headers,
                body: ['GET', 'HEAD'].includes(method) ? undefined : body,
                signal: controller.signal
            });

            const response = {
                status: res.status,
                statusText: res.statusText,
                headers: Object.fromEntries(res.headers.entries()),
                config: finalConfig,
                request: null,
                data: await parseResponse(res, finalConfig.responseType)
            };

            if (!res.ok) {
                throw createError(`Request failed with status code ${res.status}`, response);
            }

            return response;
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw createError(`timeout of ${timeout}ms exceeded`);
            }
            if (error?.isAxiosError) throw error;
            throw createError(error?.message || 'Network error');
        } finally {
            if (timer) clearTimeout(timer);
        }
    };

    // Attach convenience methods
    instance.get = (url, config = {}) => instance({ ...config, method: 'get', url });
    instance.post = (url, data, config = {}) => instance({ ...config, method: 'post', url, data });
    instance.put = (url, data, config = {}) => instance({ ...config, method: 'put', url, data });
    instance.delete = (url, config = {}) => instance({ ...config, method: 'delete', url });
    instance.patch = (url, data, config = {}) => instance({ ...config, method: 'patch', url, data });
    
    // Core Axios API
    instance.request = instance;
    instance.create = (config) => createInstance({ ...defaultConfig, ...config });
    instance.isAxiosError = (error) => Boolean(error?.isAxiosError);
    instance.defaults = defaultConfig;

    return instance;
}

// Export a default instance
const axios = createInstance();
axios.default = axios;
axios.Axios = axios; // Support for some legacy libs

module.exports = axios;
