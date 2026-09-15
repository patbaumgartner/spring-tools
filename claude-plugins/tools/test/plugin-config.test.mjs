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

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
    HOOK_SERVER,
    PLUGIN_DIR,
    SCOPED_TOOL_PREFIX,
    checkHooks,
    checkManifest,
    checkSkill,
    collectMcpTools,
    parseFrontMatter,
} from '../lib/plugin-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const pluginDir = join(repoRoot, PLUGIN_DIR);
const tools = collectMcpTools(repoRoot);
const skillsDir = join(pluginDir, 'skills');
const skillNames = readdirSync(skillsDir);

test('the language server exposes the MCP tools the plugin relies on', () => {
    for (const name of ['getProjectList', 'getProjectDiagnostics', 'fileChanged', 'fileDeleted', 'refreshWorkspace', 'getSpringBootVersion']) {
        assert.ok(tools.has(name), `MCP tool ${name} not found in the language server sources`);
    }
    assert.deepEqual(tools.get('fileChanged'), ['filePath']);
    assert.deepEqual(tools.get('getProjectDiagnostics'), ['projectName']);
});

test('hooks.json only calls existing MCP tools through the plugin-scoped server with matching parameters', () => {
    const hooks = JSON.parse(readFileSync(join(pluginDir, 'hooks', 'hooks.json'), 'utf8'));
    assert.deepEqual(checkHooks(hooks, tools), []);
    assert.equal(hooks.hooks.PostToolUse[0].hooks[0].server, HOOK_SERVER);
});

test('every skill has a SKILL.md whose name matches its directory and whose tools exist', () => {
    for (const dirName of skillNames) {
        const file = join(skillsDir, dirName, 'SKILL.md');
        assert.ok(existsSync(file), `${dirName} has no SKILL.md`);
        assert.deepEqual(checkSkill(dirName, readFileSync(file, 'utf8'), tools, skillNames), [], dirName);
    }
});

test('the quickfix skill reads explanations by diagnostic code and may look up the Spring Boot version', () => {
    const text = readFileSync(join(skillsDir, 'quickfix', 'SKILL.md'), 'utf8');
    const front = parseFrontMatter(text);
    assert.ok(text.includes('${CLAUDE_PLUGIN_ROOT}/explanations/$ARGUMENTS[0].md'));
    assert.ok(front['allowed-tools'].includes(`${SCOPED_TOOL_PREFIX}getSpringBootVersion`));
    assert.deepEqual(front.arguments, ['error_code', 'file_path', 'range']);
});

test('plugin.json and the local marketplace are consistent with the plugin directory', () => {
    const pluginJson = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
    const marketplace = JSON.parse(readFileSync(join(repoRoot, 'claude-plugins', '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.deepEqual(checkManifest(pluginJson, marketplace, repoRoot), []);
});

test('negative control: a misspelled MCP tool name in a hook is detected', () => {
    const hooks = JSON.parse(readFileSync(join(here, 'fixtures', 'bad-hooks.json'), 'utf8'));
    const errors = checkHooks(hooks, tools);
    assert.match(errors.join('\n'), /unknown MCP tool 'fileChangd'/);
    assert.match(errors.join('\n'), /server must be 'plugin:spring-tools:spring-tools-mcp'/);
    assert.match(errors.join('\n'), /input 'path' is not a parameter of fileChanged\(filePath\)/);
});

test('negative control: a skill with an unscoped or unknown tool and a wrong name is detected', () => {
    const text = readFileSync(join(here, 'fixtures', 'bad-skill.md'), 'utf8');
    const errors = checkSkill('validate', text, tools, skillNames);
    assert.match(errors.join('\n'), /name 'validat' differs from directory name/);
    assert.match(errors.join('\n'), /MCP tool 'mcp__spring-tools-mcp__getProjectList' is not scoped/);
    assert.match(errors.join('\n'), /unknown MCP tool 'getDiagnostics'/);
    assert.match(errors.join('\n'), /skill reference 'Skill\(spring-tools:nope\)' points to a missing skill/);
    assert.match(errors.join('\n'), /body mentions MCP tool 'getDiagnostics' which does not exist/);
});
