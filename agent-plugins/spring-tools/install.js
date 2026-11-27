#!/usr/bin/env node
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
// Downloads the Spring Boot language server JAR matching the plugin version and verifies its
// SHA-256. Used in-process by launcher.js and as a CLI by the SessionStart hook:
//   node install.js [--if-missing] [--dest <dir>]
// Only stderr is used for logging so the launcher's stdout stays a clean MCP channel.
// @ts-check
'use strict';

const path = require('path');
const { JAR_NAME, DEFAULT_DOWNLOAD_BASE, downloadUrls, assertAllowedUrl, proxyFor, hostMatchesNoProxy, createTunnelAgent } = require('./lib/download');
const { ensureJar, pluginVersion, defaultInstallDir, findSourceRoot } = require('./lib/installer');

/** @param {string[]} argv */
function parseArgs(argv) {
    /** @type {{ifMissing: boolean, dest: string | undefined, help: boolean}} */
    const options = { ifMissing: false, dest: undefined, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--if-missing') options.ifMissing = true;
        else if (arg === '--dest') {
            if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
                throw new Error('--dest requires a directory path');
            }
            options.dest = path.resolve(argv[++i]);
        }
        else if (arg === '--help' || arg === '-h') options.help = true;
        else throw new Error(`unknown argument: ${arg}`);
    }
    return options;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.error('usage: node install.js [--if-missing] [--dest <dir>]');
        return 0;
    }
    if (process.env.SPRING_TOOLS_LS_JAR) {
        console.error(`SPRING_TOOLS_LS_JAR is set (${process.env.SPRING_TOOLS_LS_JAR}); nothing to download.`);
        return 0;
    }
    const result = await ensureJar({ ifMissing: options.ifMissing, dest: options.dest });
    if (result.status === 'downloaded') {
        // stdout of a SessionStart hook is added to Claude's context.
        console.log(`Spring Tools downloaded its language server to ${result.jarPath}. If the Spring Tools MCP server is listed as failed, reconnect it or restart the agent client.`);
    }
    return 0;
}

if (require.main === module) {
    main().then((code) => process.exit(code), (error) => {
        console.error(`Spring Tools language server installation failed: ${error.message}`);
        process.exit(1);
    });
}

module.exports = { JAR_NAME, DEFAULT_DOWNLOAD_BASE, downloadUrls, assertAllowedUrl, proxyFor, hostMatchesNoProxy, ensureJar, pluginVersion, defaultInstallDir, parseArgs, findSourceRoot, createTunnelAgent };
