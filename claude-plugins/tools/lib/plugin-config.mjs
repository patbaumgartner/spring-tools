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

// Consistency rules between the Claude plugin configuration (manifest, hooks,
// skills) and the MCP tools implemented by the language server.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const MCP_SOURCES_DIR = 'headless-services/spring-boot-language-server/src/main/java/org/springframework/ide/vscode/boot/mcp';
export const PLUGIN_DIR = 'claude-plugins/spring-tools';
export const MCP_SERVER_NAME = 'spring-tools-mcp';
export const PLUGIN_NAME = 'spring-tools';
export const HOOK_SERVER = `plugin:${PLUGIN_NAME}:${MCP_SERVER_NAME}`;
export const SCOPED_TOOL_PREFIX = `mcp__plugin_${PLUGIN_NAME}_${MCP_SERVER_NAME}__`;

/**
 * Reads the `@Tool` annotated methods of the language server's MCP components.
 * @returns {Map<string, string[]>} tool name -> declared parameter names
 */
export function collectMcpTools(root) {
    const tools = new Map();
    const dir = join(root, MCP_SOURCES_DIR);
    if (!existsSync(dir)) {
        return tools;
    }
    for (const entry of readdirSync(dir)) {
        const file = join(dir, entry);
        if (!entry.endsWith('.java') || statSync(file).isDirectory()) {
            continue;
        }
        const text = readFileSync(file, 'utf8');
        let index = 0;
        while ((index = text.indexOf('@Tool(', index)) !== -1) {
            const rest = text.slice(index);
            const method = rest.match(/\n\s*public\s+[\w<>\[\],.? ]+?\s+(\w+)\s*\(/);
            if (method) {
                const start = index + method.index + method[0].length;
                const params = splitTopLevel(text.slice(start, matchingParen(text, start)));
                tools.set(method[1], params.map((p) => p.trim().match(/(\w+)$/)[1]));
            }
            index += '@Tool('.length;
        }
    }
    return tools;
}

/** Index of the `)` closing the parenthesis opened just before `start`, ignoring parens inside string literals. */
function matchingParen(text, start) {
    let depth = 1;
    let inString = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (c === '\\') {
                i++;
            } else if (c === '"') {
                inString = false;
            }
        } else if (c === '"') {
            inString = true;
        } else if (c === '(') {
            depth++;
        } else if (c === ')' && --depth === 0) {
            return i;
        }
    }
    throw new Error('unbalanced parentheses in MCP tool signature');
}

/** Splits a parameter list on commas that are not nested in parentheses, brackets or string literals. */
function splitTopLevel(params) {
    const result = [];
    let depth = 0;
    let inString = false;
    let current = '';
    for (let i = 0; i < params.length; i++) {
        const c = params[i];
        if (inString) {
            if (c === '\\') {
                current += c + params[++i];
                continue;
            }
            if (c === '"') {
                inString = false;
            }
        } else if (c === '"') {
            inString = true;
        } else if (c === '(' || c === '<' || c === '[') {
            depth++;
        } else if (c === ')' || c === '>' || c === ']') {
            depth--;
        } else if (c === ',' && depth === 0) {
            result.push(current);
            current = '';
            continue;
        }
        current += c;
    }
    if (current.trim()) {
        result.push(current);
    }
    return result;
}

/** Minimal YAML front matter reader for SKILL.md files (scalars and `- item` lists). */
export function parseFrontMatter(text) {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) {
        return null;
    }
    const data = {};
    const lines = match[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
        if (!kv) {
            continue;
        }
        const [, key, rawValue] = kv;
        let value = rawValue.trim();
        if (value === '') {
            const items = [];
            while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) {
                items.push(unquote(lines[++i].replace(/^\s+-\s+/, '')));
            }
            data[key] = items;
        } else if (value.startsWith('[') && value.endsWith(']')) {
            data[key] = value.slice(1, -1).split(',').map((v) => unquote(v.trim())).filter(Boolean);
        } else {
            data[key] = unquote(value);
        }
    }
    return data;
}

function unquote(value) {
    return value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

function hookEntries(hooksJson) {
    const result = [];
    for (const [event, groups] of Object.entries(hooksJson.hooks ?? {})) {
        for (const group of groups) {
            for (const hook of group.hooks ?? []) {
                result.push({ event, matcher: group.matcher, hook });
            }
        }
    }
    return result;
}

/** Validates hooks.json against the MCP tool inventory; returns error strings. */
export function checkHooks(hooksJson, tools) {
    const errors = [];
    const entries = hookEntries(hooksJson);
    if (entries.length === 0) {
        errors.push('hooks.json declares no hooks');
    }
    for (const { event, hook } of entries) {
        if (hook.type !== 'mcp_tool') {
            continue;
        }
        const where = `${event} hook '${hook.if ?? hook.tool}'`;
        if (hook.server !== HOOK_SERVER) {
            errors.push(`${where}: server must be '${HOOK_SERVER}', found '${hook.server}'`);
        }
        if (!tools.has(hook.tool)) {
            errors.push(`${where}: unknown MCP tool '${hook.tool}' (known: ${[...tools.keys()].sort().join(', ')})`);
            continue;
        }
        const params = tools.get(hook.tool);
        for (const key of Object.keys(hook.input ?? {})) {
            if (!params.includes(key)) {
                errors.push(`${where}: input '${key}' is not a parameter of ${hook.tool}(${params.join(', ')})`);
            }
        }
        for (const param of params) {
            if (!(hook.input ?? {})[param]) {
                errors.push(`${where}: parameter '${param}' of ${hook.tool} is not provided`);
            }
        }
    }
    return errors;
}

/** Validates one SKILL.md against its directory, the MCP tools and the other skills. */
export function checkSkill(dirName, text, tools, skillNames) {
    const errors = [];
    const front = parseFrontMatter(text);
    if (!front) {
        return [`${dirName}: SKILL.md has no YAML front matter`];
    }
    if (front.name !== dirName) {
        errors.push(`${dirName}: front matter name '${front.name}' differs from directory name`);
    }
    if (!front.description) {
        errors.push(`${dirName}: missing description`);
    }
    const allowed = Array.isArray(front['allowed-tools']) ? front['allowed-tools'] : (front['allowed-tools'] ? String(front['allowed-tools']).split(',').map((s) => s.trim()) : []);
    for (const entry of allowed) {
        if (entry.startsWith('mcp__')) {
            if (!entry.startsWith(SCOPED_TOOL_PREFIX)) {
                errors.push(`${dirName}: MCP tool '${entry}' is not scoped with '${SCOPED_TOOL_PREFIX}'`);
            } else if (!tools.has(entry.slice(SCOPED_TOOL_PREFIX.length))) {
                errors.push(`${dirName}: unknown MCP tool '${entry.slice(SCOPED_TOOL_PREFIX.length)}'`);
            }
        }
        const skillRef = entry.match(/^Skill\(([^:)]+):([^)]+)\)$/);
        if (skillRef) {
            if (skillRef[1] !== PLUGIN_NAME) {
                errors.push(`${dirName}: skill reference '${entry}' uses plugin '${skillRef[1]}'`);
            } else if (!skillNames.includes(skillRef[2])) {
                errors.push(`${dirName}: skill reference '${entry}' points to a missing skill`);
            }
        }
    }
    for (const match of text.matchAll(/`((?:get|file|refresh)[A-Z]\w*)`/g)) {
        if (!tools.has(match[1])) {
            errors.push(`${dirName}: body mentions MCP tool '${match[1]}' which does not exist`);
        }
    }
    return errors;
}

/** Validates plugin.json and the local marketplace; returns error strings. */
export function checkManifest(pluginJson, marketplaceJson, root) {
    const errors = [];
    if (pluginJson.name !== PLUGIN_NAME) {
        errors.push(`plugin.json name must be '${PLUGIN_NAME}'`);
    }
    if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(pluginJson.version ?? '')) {
        errors.push(`plugin.json version '${pluginJson.version}' is not X.Y.Z[-qualifier]`);
    }
    const server = pluginJson.mcpServers?.[MCP_SERVER_NAME];
    if (!server) {
        errors.push(`plugin.json must declare mcpServers.${MCP_SERVER_NAME}`);
    } else {
        if (server.command !== 'node') {
            errors.push(`mcpServers.${MCP_SERVER_NAME}.command must be 'node'`);
        }
        const launcher = (server.args ?? []).find((a) => a.endsWith('/launcher.js'));
        if (!launcher || !launcher.startsWith('${CLAUDE_PLUGIN_ROOT}/')) {
            errors.push(`mcpServers.${MCP_SERVER_NAME}.args must launch \${CLAUDE_PLUGIN_ROOT}/launcher.js`);
        } else if (!existsSync(join(root, PLUGIN_DIR, 'launcher.js'))) {
            errors.push('launcher.js is missing from the plugin directory');
        }
    }
    const entry = (marketplaceJson.plugins ?? []).find((p) => p.name === PLUGIN_NAME);
    if (!entry) {
        errors.push(`marketplace.json has no plugin named '${PLUGIN_NAME}'`);
    } else if (typeof entry.source !== 'string' || !existsSync(join(root, 'claude-plugins', entry.source, '.claude-plugin', 'plugin.json'))) {
        errors.push(`marketplace.json source '${entry.source}' does not point at a plugin directory`);
    }
    return errors;
}
