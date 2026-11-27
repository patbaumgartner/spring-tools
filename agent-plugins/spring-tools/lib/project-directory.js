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
const os = require('os');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

/** @param {{env?: NodeJS.ProcessEnv, home?: string}} [options] */
function resolveDataDir({ env = process.env, home = os.homedir() } = {}) {
    return path.resolve(env.SPRING_TOOLS_DATA_DIR || env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA || path.join(home, '.spring-tools', 'data'));
}

/** @param {string} dir */
function isDirectory(dir) {
    try {
        return fs.statSync(dir).isDirectory();
    } catch {
        return false;
    }
}

/**
 * An absolute, existing directory that is not the plugin's own root (which is never a workspace).
 * @param {string | null | undefined} dir
 * @param {string} pluginRoot
 * @returns {dir is string}
 */
function usableProjectDir(dir, pluginRoot) {
    return !!dir && path.isAbsolute(dir) && path.resolve(dir) !== path.resolve(pluginRoot) && isDirectory(dir);
}

/**
 * GitHub Copilot CLI starts plugin MCP servers with the plugin root as working directory and passes
 * no workspace path, but it records the session's directory before starting them.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
function copilotWorkspaceDir(env, home) {
    const session = env.COPILOT_AGENT_SESSION_ID;
    // A session id is a single path segment; anything else would escape the session-state directory.
    if (!session || !/^[\w.-]+$/.test(session) || session === '.' || session === '..') {
        return null;
    }
    try {
        const state = fs.readFileSync(path.join(home, '.copilot', 'session-state', session, 'workspace.yaml'), 'utf8');
        return /^cwd:[ \t]*(.+?)[ \t]*$/m.exec(state)?.[1] ?? null;
    } catch {
        return null;
    }
}

/**
 * Workspace the language server should index. Claude Code exports CLAUDE_PROJECT_DIR; Copilot CLI
 * runs it in the plugin directory, so the workspace has to be recovered from session state. Other
 * plugin hosts may also change the MCP process cwd, so prefer the inherited PWD to that fallback.
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string, pluginRoot?: string, home?: string}} [options]
 * @returns {{dir: string, source: string, detected: boolean}}
 */
function resolveProjectDir({ env = process.env, cwd = process.cwd(), pluginRoot = PLUGIN_ROOT, home = os.homedir() } = {}) {
    const override = env.SPRING_TOOLS_PROJECT_DIR;
    if (override) {
        const dir = path.resolve(cwd, override);
        if (!isDirectory(dir)) {
            throw new Error(`SPRING_TOOLS_PROJECT_DIR is not an existing directory: ${dir}`);
        }
        return { dir, source: 'SPRING_TOOLS_PROJECT_DIR', detected: true };
    }
    const candidates = [
        { dir: env.CLAUDE_PROJECT_DIR, source: 'CLAUDE_PROJECT_DIR' },
        { dir: copilotWorkspaceDir(env, home), source: 'Copilot session state' },
        { dir: env.PWD, source: 'PWD' },
        { dir: cwd, source: 'working directory' },
    ];
    for (const candidate of candidates) {
        if (usableProjectDir(candidate.dir, pluginRoot)) {
            return { dir: path.resolve(candidate.dir), source: candidate.source, detected: true };
        }
    }
    return { dir: path.resolve(cwd), source: 'working directory', detected: false };
}

module.exports = { resolveDataDir, resolveProjectDir };
