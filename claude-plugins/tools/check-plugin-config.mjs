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

// Checks the Claude Code plugin configuration against the language server's MCP tools:
//   node claude-plugins/tools/check-plugin-config.mjs
// Fails when a hook, skill or agent references an unknown tool, when a skill/agent is malformed,
// when the manifest is inconsistent, or when an MCP tool is reachable through no skill and no hook.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    PLUGIN_DIR,
    checkAgent,
    checkEvals,
    checkHooks,
    checkManifest,
    checkSkill,
    collectMcpTools,
    uncoveredTools,
} from './lib/plugin-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const pluginDir = join(repoRoot, PLUGIN_DIR);

const errors = [];
const tools = collectMcpTools(repoRoot);
if (tools.size === 0) {
    errors.push('no @Tool methods found in the language server sources');
}

const hooks = JSON.parse(readFileSync(join(pluginDir, 'hooks', 'hooks.json'), 'utf8'));
errors.push(...checkHooks(hooks, tools, repoRoot));

const skillsDir = join(pluginDir, 'skills');
const skillNames = readdirSync(skillsDir).filter((d) => existsSync(join(skillsDir, d, 'SKILL.md')));
const skillTexts = [];
for (const name of readdirSync(skillsDir)) {
    const file = join(skillsDir, name, 'SKILL.md');
    if (!existsSync(file)) {
        errors.push(`${name}: skill directory without SKILL.md`);
        continue;
    }
    const text = readFileSync(file, 'utf8');
    skillTexts.push(text);
    errors.push(...checkSkill(name, text, tools, skillNames));
}

const agentsDir = join(pluginDir, 'agents');
const agentFiles = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith('.md')) : [];
for (const file of agentFiles) {
    errors.push(...checkAgent(file, readFileSync(join(agentsDir, file), 'utf8'), tools));
}

const pluginJson = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
const marketplace = JSON.parse(readFileSync(join(repoRoot, 'claude-plugins', '.claude-plugin', 'marketplace.json'), 'utf8'));
errors.push(...checkManifest(pluginJson, marketplace, repoRoot));

const uncovered = uncoveredTools(tools, skillTexts, hooks);
if (uncovered.length) {
    errors.push(`MCP tools reachable through no skill and no hook: ${uncovered.join(', ')}`);
}

const evalsDir = join(pluginDir, 'evals');
errors.push(...checkEvals(evalsDir, tools, skillNames, agentFiles.map((f) => f.replace(/\.md$/, ''))));
const evalCases = existsSync(evalsDir) ? readdirSync(evalsDir).filter((d) => existsSync(join(evalsDir, d, 'prompt.md'))).length : 0;

if (errors.length) {
    for (const error of errors) {
        console.error(`ERROR ${error}`);
    }
    console.error(`plugin config FAILED: ${errors.length} problem(s)`);
    process.exit(1);
}
console.log(`plugin config OK (${tools.size} tools, ${skillNames.length} skills, ${agentFiles.length} agent(s), ${evalCases} eval case(s), every tool covered by a skill or hook)`);
