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
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
    HOOK_SERVER,
    PLUGIN_DIR,
    SCOPED_TOOL_PREFIX,
    checkAgent,
    checkEvals,
    checkHooks,
    checkManifest,
    checkSkill,
    collectMcpTools,
    parseFrontMatter,
    skillToolNames,
    uncoveredTools,
} from '../lib/plugin-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const pluginDir = join(repoRoot, PLUGIN_DIR);
const tools = collectMcpTools(repoRoot);
const skillsDir = join(pluginDir, 'skills');
const skillNames = readdirSync(skillsDir);
const skillText = (name) => readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
const agentsDir = join(pluginDir, 'agents');
const agentFiles = readdirSync(agentsDir).filter((f) => f.endsWith('.md'));

test('the language server exposes the MCP tools the plugin relies on', () => {
    for (const name of ['getProjectList', 'getProjectDiagnostics', 'fileChanged', 'fileDeleted', 'refreshWorkspace', 'getSpringBootVersion']) {
        assert.ok(tools.has(name), `MCP tool ${name} not found in the language server sources`);
    }
    assert.deepEqual(tools.get('fileChanged'), ['filePath']);
    assert.deepEqual(tools.get('getProjectDiagnostics'), ['projectName']);
});

test('hooks.json only calls existing MCP tools through the plugin-scoped server with matching parameters', () => {
    const hooks = JSON.parse(readFileSync(join(pluginDir, 'hooks', 'hooks.json'), 'utf8'));
    assert.deepEqual(checkHooks(hooks, tools, repoRoot), []);
    assert.equal(hooks.hooks.PostToolUse[0].hooks[0].server, HOOK_SERVER);
});

test('hooks.json pre-downloads the JAR at session start and refreshes the index after commands that rewrite the tree', () => {
    const hooks = JSON.parse(readFileSync(join(pluginDir, 'hooks', 'hooks.json'), 'utf8'));
    const start = hooks.hooks.SessionStart.flatMap((g) => g.hooks);
    assert.equal(start.length, 1);
    assert.equal(start[0].type, 'command');
    assert.equal(start[0].command, 'node');
    assert.deepEqual(start[0].args, ['${CLAUDE_PLUGIN_ROOT}/install.js', '--if-missing']);
    assert.ok(start[0].timeout >= 300, 'the first-run download needs more than the default hook budget on slow links');

    const post = hooks.hooks.PostToolUse.flatMap((g) => g.hooks);
    const refreshRules = post.filter((h) => h.tool === 'refreshWorkspace').map((h) => h.if);
    for (const rule of ['Bash(git *)', 'Bash(rm *)', 'Bash(mv *)', 'Bash(tar *)', 'Bash(unzip *)', 'PowerShell(git *)', 'PowerShell(Remove-Item *)']) {
        assert.ok(refreshRules.includes(rule), `${rule} should trigger refreshWorkspace`);
    }
    const fileRules = post.filter((h) => h.tool === 'fileChanged').map((h) => h.if);
    for (const ext of ['java', 'kt', 'xml', 'properties', 'yml', 'yaml', 'factories', 'gradle', 'kts']) {
        assert.ok(fileRules.includes(`Edit(*.${ext})`), `edits of *.${ext} should trigger fileChanged`);
    }
    assert.ok(post.filter((h) => h.tool === 'fileChanged').every((h) => h.input.filePath === '${tool_input.file_path}'));
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
    // Named arguments expand to an empty string when omitted; $ARGUMENTS[2] would stay literal.
    assert.deepEqual(front.arguments, ['code', 'file', 'range']);
    assert.ok(text.includes('${CLAUDE_PLUGIN_ROOT}/explanations/$code.md'));
    assert.ok(!/\$ARGUMENTS\[/.test(text), 'quickfix should use the named placeholders only');
    assert.ok(front['allowed-tools'].includes(`${SCOPED_TOOL_PREFIX}getSpringBootVersion`));
});

test('the validate skill pre-approves quickfix invocations that carry arguments', () => {
    const front = parseFrontMatter(readFileSync(join(skillsDir, 'validate', 'SKILL.md'), 'utf8'));
    assert.ok(front['allowed-tools'].includes('Skill(spring-tools:quickfix *)'));
    assert.ok(!front['allowed-tools'].includes('Skill(spring-tools:quickfix)'), 'the exact-match form only covers an argument-less call');
});

test('the create-spring-boot-project skill only grants the start.spring.io lookup and registers the new project', () => {
    const text = readFileSync(join(skillsDir, 'create-spring-boot-project', 'SKILL.md'), 'utf8');
    const allowed = parseFrontMatter(text)['allowed-tools'];
    assert.ok(allowed.includes('Bash(curl -sS https://start.spring.io)'));
    assert.ok(!allowed.some((rule) => /^Bash\(curl -sS \*\)$/.test(rule)), 'no blanket curl grant');
    assert.ok(text.includes('curl -sS https://start.spring.io | grep'), 'the body must use exactly the granted lookup command');
    assert.ok(allowed.includes(`${SCOPED_TOOL_PREFIX}refreshWorkspace`));
    assert.match(text, /refreshWorkspace/);
});

test('plugin.json and the local marketplace are consistent with the plugin directory', () => {
    const pluginJson = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
    const marketplace = JSON.parse(readFileSync(join(repoRoot, 'claude-plugins', '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.deepEqual(checkManifest(pluginJson, marketplace, repoRoot), []);
});

test('negative control: a misspelled MCP tool name in a hook is detected', () => {
    const hooks = JSON.parse(readFileSync(join(here, 'fixtures', 'bad-hooks.json'), 'utf8'));
    const errors = checkHooks(hooks, tools, repoRoot);
    assert.match(errors.join('\n'), /unknown MCP tool 'fileChangd'/);
    assert.match(errors.join('\n'), /server must be 'plugin:spring-tools:spring-tools-mcp'/);
    assert.match(errors.join('\n'), /input 'path' is not a parameter of fileChanged\(filePath\)/);
    assert.match(errors.join('\n'), /skips mcp_tool hooks on SessionStart/);
    assert.match(errors.join('\n'), /does not exist in the plugin directory/);
    assert.match(errors.join('\n'), /path placeholders belong in exec-form 'args'/);
});

test('negative control: a skill with an unscoped or unknown tool and a wrong name is detected', () => {
    const text = readFileSync(join(here, 'fixtures', 'bad-skill.md'), 'utf8');
    const errors = checkSkill('validate', text, tools, skillNames);
    assert.match(errors.join('\n'), /name 'validat' differs from directory name/);
    assert.match(errors.join('\n'), /MCP tool 'mcp__spring-tools-mcp__getProjectList' is not scoped/);
    assert.match(errors.join('\n'), /unknown MCP tool 'getDiagnostics'/);
    assert.match(errors.join('\n'), /skill reference 'Skill\(spring-tools:nope\)' points to a missing skill/);
    assert.match(errors.join('\n'), /skill reference 'Skill\(quickfix\)' must look like/);
    assert.match(errors.join('\n'), /body mentions MCP tool 'getDiagnostics' which does not exist/);
});

test('every MCP tool of the language server is reachable through a skill or a hook', () => {
    const hooks = JSON.parse(readFileSync(join(pluginDir, 'hooks', 'hooks.json'), 'utf8'));
    assert.deepEqual(uncoveredTools(tools, skillNames.map(skillText), hooks), []);
    assert.ok(tools.size >= 26, `expected the full tool inventory, found ${tools.size}`);
    assert.ok(skillNames.length >= 9, `expected at least 9 skills, found ${skillNames.length}`);
});

test('the analysis skills grant exactly the tools their body walks through', () => {
    const expectations = {
        beans: ['getProjectList', 'getBeanDetails', 'findBeansByType', 'getBeanUsageInfo'],
        endpoints: ['getProjectList', 'getRequestMappings', 'findRequestMappingsByMethod'],
        architecture: ['getProjectList', 'getLogicalStructure', 'getStereotypesList', 'findComponentsByStereotype', 'getListOfComponentsAndTheirStereotypes',
            'captureLogicalStructureBaseline', 'getLogicalStructureChanges', 'getLogicalStructureBaselineHistory', 'clearLogicalStructureBaseline'],
        'spring-versions': ['getProjectList', 'getSpringBootVersion', 'getLatestReleaseInformation', 'getLatestBootVersionsFromMavenRepo', 'getReleases', 'getGenerations', 'getUpcomingReleases'],
        'project-info': ['getProjectList', 'getJavaVersion', 'getSpringBootVersion', 'getResolvedProjectClasspath'],
        refresh: ['refreshWorkspace', 'fileChanged', 'fileDeleted'],
    };
    for (const [skill, expected] of Object.entries(expectations)) {
        const text = skillText(skill);
        assert.deepEqual(skillToolNames(text).sort(), [...expected].sort(), skill);
        for (const name of expected) {
            assert.ok(text.includes(`\`${name}\``), `${skill} body should explain when to use ${name}`);
        }
    }
    // Skills that ask questions of the index must not be allowed to change files.
    for (const skill of ['beans', 'endpoints', 'architecture', 'spring-versions', 'project-info']) {
        const allowed = parseFrontMatter(skillText(skill))['allowed-tools'];
        assert.ok(!allowed.some((rule) => /^(Edit|Write|Bash|NotebookEdit)\b/.test(rule)), `${skill} must stay read-only`);
    }
});

test('the spring-versions skill separates workspace project names from Spring IO slugs', () => {
    const text = skillText('spring-versions');
    assert.match(text, /spring-boot.*spring-framework/s, 'names the Spring IO slugs');
    assert.match(text, /getLatestBootVersionsFromMavenRepo[\s\S]*Gradle/, 'documents the Maven-only limitation');
});

test('agents/ ships a read-only Spring reviewer whose MCP grant is scoped to the plugin server', () => {
    assert.ok(agentFiles.includes('spring-reviewer.md'));
    for (const file of agentFiles) {
        const text = readFileSync(join(agentsDir, file), 'utf8');
        assert.deepEqual(checkAgent(file, text, tools), [], file);
    }
    const reviewer = parseFrontMatter(readFileSync(join(agentsDir, 'spring-reviewer.md'), 'utf8'));
    const granted = String(reviewer.tools).split(',').map((s) => s.trim());
    assert.ok(granted.includes(`${SCOPED_TOOL_PREFIX}*`), 'the reviewer needs every plugin MCP tool');
    assert.ok(!granted.some((t) => /^(Edit|Write|Bash|NotebookEdit)$/.test(t)), 'a reviewer must not edit or run commands');
    assert.ok(reviewer.description.length <= 250, 'agent descriptions are shown in the agent list; keep them short');
});

test('negative control: a malformed plugin agent is detected', () => {
    const errors = checkAgent('spring-reviewer.md', readFileSync(join(here, 'fixtures', 'bad-agent.md'), 'utf8'), tools);
    assert.match(errors.join('\n'), /name 'spring-review' differs from file name 'spring-reviewer'/);
    assert.match(errors.join('\n'), /too short description/);
    assert.match(errors.join('\n'), /'hooks' is ignored for agents shipped in a plugin/);
    assert.match(errors.join('\n'), /MCP tool 'mcp__spring-tools-mcp__getProjectList' is not scoped/);
    assert.match(errors.join('\n'), /unknown MCP tool 'getDiagnostics'/);
    assert.match(errors.join('\n'), /body mentions MCP tool 'getDiagnostics'/);
});

test('negative control: a tool nobody grants shows up as uncovered', () => {
    const extended = new Map(tools);
    extended.set('getSomethingNew', ['projectName']);
    const hooks = JSON.parse(readFileSync(join(pluginDir, 'hooks', 'hooks.json'), 'utf8'));
    assert.deepEqual(uncoveredTools(extended, skillNames.map(skillText), hooks), ['getSomethingNew']);
    assert.deepEqual(uncoveredTools(new Map([['fileChanged', ['filePath']]]), [], hooks), [], 'hooks count as coverage');
});

test('check-plugin-config.mjs reports the inventory it validated', () => {
    const result = spawnSync(process.execPath, [join(here, '..', 'check-plugin-config.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^plugin config OK \(\d+ tools, \d+ skills, \d+ agent\(s\), \d+ eval case\(s\), every tool covered by a skill or hook\)/);
});

test('the eval suite mocks every MCP tool with the recorded tools/list and covers every skill and agent with a case', () => {
    const agentNames = agentFiles.map((f) => f.replace(/\.md$/, ''));
    assert.deepEqual(checkEvals(join(pluginDir, 'evals'), tools, skillNames, agentNames), []);
    const mocks = readdirSync(join(pluginDir, 'evals', 'mocks', 'spring-tools-mcp'));
    assert.ok(mocks.includes('_tools.json'));
    assert.equal(mocks.filter((f) => f.endsWith('.md')).length, tools.size);
    // The validate and reviewer cases get a diagnostics recording that contains a Java diagnostic.
    for (const name of ['validate-finds-spring-problems', 'reviewer-agent-reviews-project']) {
        const override = readFileSync(join(pluginDir, 'evals', name, 'mocks', 'spring-tools-mcp', 'getProjectDiagnostics.md'), 'utf8');
        assert.match(override, /JAVA_AUTOWIRED_CONSTRUCTOR/);
        assert.match(override, /expect:\n\s+projectName: sf7-validation/);
    }
    // Recordings must not leak the machine they were taken on.
    for (const file of mocks.filter((f) => f.endsWith('.md'))) {
        assert.doesNotMatch(readFileSync(join(pluginDir, 'evals', 'mocks', 'spring-tools-mcp', file), 'utf8'), /\/tmp\/|\/home\//, `${file} contains a local path`);
    }
});

test('negative control: a broken eval suite is rejected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spring-tools-evals-'));
    try {
        mkdirSync(join(dir, 'mocks', 'spring-tools-mcp'), { recursive: true });
        writeFileSync(join(dir, 'mocks', 'spring-tools-mcp', 'getEverything.md'), 'nope\n');
        writeFileSync(join(dir, 'mocks', 'spring-tools-mcp', '_tools.json'), JSON.stringify({ tools: [{ name: 'getProjectList' }] }));
        mkdirSync(join(dir, 'no-graders'));
        writeFileSync(join(dir, 'no-graders', 'prompt.md'), '---\nmax_turns: 5\n---\n\nHello\n');
        mkdirSync(join(dir, 'bad-refs', 'graders'), { recursive: true });
        writeFileSync(join(dir, 'bad-refs', 'prompt.md'), 'Do the thing\n');
        writeFileSync(join(dir, 'bad-refs', 'graders', 'tool.md'), `---\ntype: tool_used\ntool: ${SCOPED_TOOL_PREFIX}getNothing\n---\n`);
        writeFileSync(join(dir, 'bad-refs', 'graders', 'skill.md'), '---\ntype: tool_used\ntool: Skill\ninput_match: \'"skill"\\s*:\\s*"(?:[\\w-]+:)?nonexistent"\'\n---\n');
        writeFileSync(join(dir, 'bad-refs', 'graders', 'agent.md'), '---\ntype: tool_used\ntool: Agent\ninput_match: ghost-agent\n---\n');
        writeFileSync(join(dir, 'bad-refs', 'graders', 'untyped.md'), 'PASS if anything.\n');
        const errors = checkEvals(dir, tools, ['validate'], ['spring-reviewer']);
        const expect = (pattern) => assert.ok(errors.some((e) => pattern.test(e)), `expected an error matching ${pattern}, got:\n${errors.join('\n')}`);
        expect(/mock getEverything\.md answers unknown tool/);
        expect(/_tools\.json differs/);
        expect(/tools without a suite-wide mock/);
        expect(/no-graders: no graders/);
        expect(/getNothing' does not exist/);
        expect(/skill 'nonexistent' does not exist/);
        expect(/agent 'ghost-agent' does not exist/);
        expect(/untyped\.md: no type/);
        expect(/skill 'validate' has no case/);
        expect(/agent 'spring-reviewer' has no case/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
