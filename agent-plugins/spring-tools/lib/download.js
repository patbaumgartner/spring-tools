/*******************************************************************************
 * Copyright (c) 2026 Broadcom
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v1.0
 * which accompanies this distribution, and is available at
 * https://www.eclipse.org/legal/epl-v10.html
 *
 * Contributors:
 *     Broadcom - initial API and implementation
 *******************************************************************************/
// @ts-check
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const JAR_NAME = 'spring-boot-language-server-standalone-exec.jar';
const DEFAULT_DOWNLOAD_BASE = 'https://cdn.spring.io/spring-tools';
const MAX_REDIRECTS = 5;
const SOCKET_IDLE_TIMEOUT_MS = 60000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Release versions live under release/<version>/, anything with a qualifier under snapshot/.
 * @param {string} version
 * @param {string} [base]
 */
function downloadUrls(version, base = process.env.SPRING_TOOLS_LS_DOWNLOAD_BASE || DEFAULT_DOWNLOAD_BASE) {
    const root = base.replace(/\/+$/, '');
    const jarUrl = version.includes('-')
        ? `${root}/snapshot/language-server/spring-boot/${JAR_NAME}`
        : `${root}/release/language-server/spring-boot/${version}/${JAR_NAME}`;
    return { jarUrl, sha256Url: `${jarUrl}.sha256` };
}

/**
 * Hosts a download may come from: the CDN, plus a configured mirror. Plain HTTP only for loopback (tests).
 * @param {string} url
 * @param {string} [base]
 */
function assertAllowedUrl(url, base = process.env.SPRING_TOOLS_LS_DOWNLOAD_BASE || DEFAULT_DOWNLOAD_BASE) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`Invalid URL: ${url}`);
    }
    const allowedHosts = new Set([new URL(DEFAULT_DOWNLOAD_BASE).hostname, new URL(base).hostname]);
    if (!allowedHosts.has(parsed.hostname)) {
        throw new Error(`Refusing to fetch from untrusted host: ${url}`);
    }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) {
        throw new Error(`Refusing insecure download URL: ${url}`);
    }
    return parsed;
}

/**
 * @param {string} hostname
 * @param {string | undefined} noProxy
 */
function hostMatchesNoProxy(hostname, noProxy) {
    if (!noProxy) {
        return false;
    }
    return noProxy.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean).some((entry) => {
        if (entry === '*') {
            return true;
        }
        const pattern = entry.replace(/^\./, '').replace(/:\d+$/, '');
        return hostname === pattern || hostname.endsWith(`.${pattern}`);
    });
}

/**
 * Proxy URL for a target, following curl's HTTPS_PROXY/HTTP_PROXY/ALL_PROXY and NO_PROXY conventions.
 * @param {string} targetUrl
 * @param {NodeJS.ProcessEnv} [env]
 */
function proxyFor(targetUrl, env = process.env) {
    const target = new URL(targetUrl);
    const hostname = target.hostname.toLowerCase();
    if (LOOPBACK_HOSTS.has(hostname) || hostMatchesNoProxy(hostname, env.NO_PROXY || env.no_proxy)) {
        return null;
    }
    const candidates = target.protocol === 'https:'
        ? [env.HTTPS_PROXY, env.https_proxy, env.ALL_PROXY, env.all_proxy]
        : [env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy];
    const proxy = candidates.find((value) => value && value.trim());
    if (!proxy) {
        return null;
    }
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(proxy) ? proxy : `http://${proxy}`);
    if (parsed.protocol !== 'http:') {
        throw new Error(`Unsupported proxy protocol ${parsed.protocol} (only http:// proxies are supported)`);
    }
    return parsed;
}

/** @param {URL} proxy */
function proxyAuthHeader(proxy) {
    if (!proxy.username && !proxy.password) {
        return null;
    }
    const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
    return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

/**
 * Opens a CONNECT tunnel through an HTTP proxy and wraps it in TLS for the target host.
 * @param {URL} proxy
 * @param {URL} target
 * @returns {Promise<import('tls').TLSSocket>}
 */
function connectThroughProxy(proxy, target) {
    return new Promise((resolve, reject) => {
        const port = target.port || 443;
        const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) || 80 });
        socket.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => {
            socket.destroy(new Error(`Timed out connecting to proxy ${proxy.host}`));
        });
        socket.once('error', reject);
        socket.once('connect', () => {
            const auth = proxyAuthHeader(proxy);
            socket.write(`CONNECT ${target.hostname}:${port} HTTP/1.1\r\nHost: ${target.hostname}:${port}\r\n`
                + (auth ? `Proxy-Authorization: ${auth}\r\n` : '') + 'Connection: keep-alive\r\n\r\n');
        });
        let response = '';
        /** @param {Buffer} chunk */
        const onData = (chunk) => {
            response += chunk.toString('latin1');
            const end = response.indexOf('\r\n\r\n');
            if (end === -1) {
                return;
            }
            socket.removeListener('data', onData);
            const statusLine = response.slice(0, response.indexOf('\r\n'));
            if (!/^HTTP\/1\.[01] 200\b/.test(statusLine)) {
                socket.destroy();
                reject(new Error(`Proxy ${proxy.host} refused CONNECT to ${target.hostname}:${port}: ${statusLine}`));
                return;
            }
            const leftover = response.slice(end + 4);
            if (leftover.length) {
                socket.destroy();
                reject(new Error(`Proxy ${proxy.host} sent unexpected data after the CONNECT response`));
                return;
            }
            socket.pause();
            const secure = tls.connect({ socket, servername: target.hostname });
            secure.once('secureConnect', () => resolve(secure));
            secure.once('error', reject);
        };
        socket.on('data', onData);
    });
}

/** @param {URL} target */
function urlToOptions(target) {
    return {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
    };
}

/** @param {import('tls').TLSSocket} socket */
function createTunnelAgent(socket) {
    const agent = new https.Agent({ keepAlive: false });
    agent.createConnection = () => socket;
    return agent;
}

/**
 * GET with redirects, host allow-list and proxy support; resolves with a 200 response stream.
 * @param {string} url
 * @param {number} [redirectCount]
 * @returns {Promise<import('http').IncomingMessage>}
 */
async function get(url, redirectCount = 0) {
    const target = assertAllowedUrl(url);
    const proxy = proxyFor(url);
    const headers = { 'user-agent': 'spring-tools-claude-plugin' };
    let request;
    if (proxy && target.protocol === 'https:') {
        const socket = await connectThroughProxy(proxy, target);
        request = https.request({ ...urlToOptions(target), headers, agent: createTunnelAgent(socket) });
    } else if (proxy) {
        const auth = proxyAuthHeader(proxy);
        request = http.request({
            host: proxy.hostname, port: Number(proxy.port) || 80, method: 'GET', path: target.href,
            headers: { ...headers, host: target.host, ...(auth ? { 'proxy-authorization': auth } : {}) },
        });
    } else {
        request = (target.protocol === 'https:' ? https : http).request({ ...urlToOptions(target), headers });
    }
    const response = await new Promise((resolve, reject) => {
        request.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => request.destroy(new Error(`Timed out fetching ${url}`)));
        request.once('response', resolve);
        request.once('error', reject);
        request.end();
    });
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirectCount >= MAX_REDIRECTS) {
            throw new Error(`Too many redirects while fetching ${url}`);
        }
        return get(new URL(response.headers.location, url).toString(), redirectCount + 1);
    }
    if (response.statusCode !== 200) {
        response.resume();
        throw new Error(`Failed to fetch ${url}: HTTP ${response.statusCode}`);
    }
    return response;
}

/** @param {string} url */
async function fetchText(url) {
    const response = await get(url);
    let data = '';
    for await (const chunk of response) {
        data += chunk;
        if (data.length > 4096) {
            throw new Error(`Unexpectedly large checksum file at ${url}`);
        }
    }
    return data.trim();
}

/**
 * Streams the URL into dest while hashing; resolves with the hex SHA-256 of what was written.
 * @param {string} url
 * @param {string} dest
 * @param {(line: string) => void} log
 */
async function downloadFile(url, dest, log) {
    const response = await get(url);
    const total = Number(response.headers['content-length']) || 0;
    const hash = crypto.createHash('sha256');
    let received = 0;
    let nextReport = 0;
    const meter = new Transform({
        transform(chunk, encoding, callback) {
            hash.update(chunk);
            received += chunk.length;
            if (total && received >= nextReport) {
                log(`  ${Math.floor((received / total) * 100)}% (${Math.round(received / 1048576)} of ${Math.round(total / 1048576)} MB)`);
                nextReport += Math.max(total / 10, 1);
            }
            callback(null, chunk);
        },
    });
    await pipeline(response, meter, fs.createWriteStream(dest, { flags: 'wx' }));
    if (total && received !== total) {
        throw new Error(`Download of ${url} ended after ${received} of ${total} bytes`);
    }
    return hash.digest('hex');
}

module.exports = {
    JAR_NAME,
    DEFAULT_DOWNLOAD_BASE,
    downloadUrls,
    assertAllowedUrl,
    hostMatchesNoProxy,
    proxyFor,
    createTunnelAgent,
    fetchText,
    downloadFile,
};
