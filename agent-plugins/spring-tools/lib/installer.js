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
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { JAR_NAME, downloadUrls, fetchText, downloadFile } = require('./download');
const { acquireLock, removeStalePartials } = require('./install-lock');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

// The Agent Plugins manifest at the plugin root is the one both clients can read; the Claude Code
// manifest in .claude-plugin/ is the fallback for older layouts.
/** @param {string} pluginRoot */
function pluginVersion(pluginRoot) {
    const manifestPath = [path.join(pluginRoot, 'plugin.json'), path.join(pluginRoot, '.claude-plugin', 'plugin.json')]
        .find((candidate) => fs.existsSync(candidate));
    if (!manifestPath) {
        throw new Error(`no plugin.json found in ${pluginRoot}`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (typeof manifest.version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(manifest.version)) {
        throw new Error('plugin.json has no valid version');
    }
    return manifest.version;
}

/**
 * @param {string} [pluginRoot]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 */
function defaultInstallDir(pluginRoot = PLUGIN_ROOT, env = process.env, home = os.homedir()) {
    const dataDir = env.SPRING_TOOLS_DATA_DIR || env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA || path.join(home, '.spring-tools', 'data');
    // Keep artifacts from different plugin releases isolated; an old JAR must never satisfy
    // --if-missing after the plugin version changes.
    return path.resolve(dataDir, 'language-server', pluginVersion(pluginRoot));
}

/**
 * @param {string} pluginRoot
 * @param {NodeJS.ProcessEnv} [env]
 */
function findSourceRoot(pluginRoot, env = process.env) {
    const fallback = path.resolve(pluginRoot, '..', '..');
    const candidates = env.SPRING_TOOLS_SOURCE_DIR ? [env.SPRING_TOOLS_SOURCE_DIR, fallback] : [fallback];
    return candidates.map((candidate) => path.resolve(candidate)).find((root) =>
        fs.existsSync(path.join(root, 'headless-services', 'pom.xml'))
        && (fs.existsSync(path.join(root, 'headless-services', 'mvnw')) || fs.existsSync(path.join(root, 'headless-services', 'mvnw.cmd'))));
}

/**
 * @param {string} pluginRoot
 * @param {string} dest
 * @param {(line: string) => void} log
 */
function buildJar(pluginRoot, dest, log) {
    const sourceRoot = findSourceRoot(pluginRoot);
    if (!sourceRoot) {
        throw new Error('No Spring Tools source checkout found for a local build. Set SPRING_TOOLS_SOURCE_DIR to the repository root, or install the JAR manually and set SPRING_TOOLS_LS_JAR.');
    }
    const servicesDir = path.join(sourceRoot, 'headless-services');
    const wrapper = path.join(servicesDir, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw');
    const args = ['-pl', 'spring-boot-language-server-standalone', '-am', '-DskipTests', 'package'];
    log(`Building Spring Boot Language Server from ${sourceRoot}`);
    // Maven must not read MCP requests or write build output to the MCP stdout transport.
    const result = spawnSync(wrapper, args, { cwd: servicesDir, stdio: ['ignore', 2, 2], shell: process.platform === 'win32' });
    if (result.error || result.status !== 0) {
        throw new Error(`Local language server build failed${result.error ? `: ${result.error.message}` : ` (exit code ${result.status})`}`);
    }
    const targetDir = path.join(sourceRoot, 'headless-services', 'spring-boot-language-server-standalone', 'target');
    const builtJar = fs.readdirSync(targetDir).filter((name) => name.endsWith('-standalone-exec.jar')).sort().at(-1);
    if (!builtJar) throw new Error(`Maven build completed but no standalone JAR was found in ${targetDir}`);
    const temporary = path.join(dest, `${JAR_NAME}.${process.pid}.part`);
    try {
        fs.copyFileSync(path.join(targetDir, builtJar), temporary, fs.constants.COPYFILE_EXCL);
        fs.renameSync(temporary, path.join(dest, JAR_NAME));
    } finally {
        try { fs.unlinkSync(temporary); } catch { /* already renamed or absent */ }
    }
    log(`Built Spring Boot Language Server and installed it to ${path.join(dest, JAR_NAME)}`);
}

/**
 * Makes sure <dest>/<JAR_NAME> exists for the given plugin version.
 * @param {{pluginRoot?: string, dest?: string, ifMissing?: boolean, log?: (line: string) => void}} [options]
 * @returns {Promise<{status: 'present'|'downloaded'|'built', jarPath: string}>}
 */
async function ensureJar({ pluginRoot = PLUGIN_ROOT, dest = defaultInstallDir(pluginRoot), ifMissing = false, log = (line) => console.error(line) } = {}) {
    const jarPath = path.join(dest, JAR_NAME);
    if (ifMissing && fs.existsSync(jarPath)) {
        return { status: 'present', jarPath };
    }
    const version = pluginVersion(pluginRoot);
    fs.mkdirSync(dest, { recursive: true });
    const release = await acquireLock(`${jarPath}.lock`);
    try {
        if (ifMissing && fs.existsSync(jarPath)) {
            return { status: 'present', jarPath };
        }
        removeStalePartials(dest, JAR_NAME);
        try {
            const { jarUrl, sha256Url } = downloadUrls(version);
            log(`Downloading Spring Boot Language Server ${version} from ${jarUrl}`);
            const expected = (await fetchText(sha256Url)).split(/\s+/)[0].toLowerCase();
            if (!/^[0-9a-f]{64}$/.test(expected)) {
                throw new Error(`Checksum file ${sha256Url} does not contain a SHA-256 digest`);
            }
            const partPath = `${jarPath}.${process.pid}.part`;
            try {
                const actual = await downloadFile(jarUrl, partPath, log);
                if (actual !== expected) throw new Error(`Checksum mismatch for ${JAR_NAME}: expected ${expected}, got ${actual}`);
                fs.renameSync(partPath, jarPath);
            } finally {
                try { fs.unlinkSync(partPath); } catch { /* renamed away or never created */ }
            }
            log(`Installed Spring Boot Language Server ${version} to ${jarPath}`);
            return { status: 'downloaded', jarPath };
        } catch (downloadError) {
            log(`Language server download failed: ${errorMessage(downloadError)}`);
            try {
                buildJar(pluginRoot, dest, log);
                return { status: 'built', jarPath };
            } catch (buildError) {
                throw new Error(`Could not download or build the Spring Tools language server. Download error: ${errorMessage(downloadError)}. Build error: ${errorMessage(buildError)}`);
            }
        }
    } finally {
        release();
    }
}

module.exports = { ensureJar, pluginVersion, defaultInstallDir, findSourceRoot };
