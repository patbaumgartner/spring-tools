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

// Unit tests for the pure parts of launcher.js (Java selection, JVM arguments). The end-to-end
// behaviour against a real JVM is covered by tools/smoke/mcp-smoke.mjs.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..', '..', 'spring-tools');
const launcher = require(join(pluginRoot, 'launcher.js'));
const { MIN_JAVA_MAJOR, SERVER_INSTRUCTIONS, parseJavaMajor, javaCandidates, pickJava, splitOpts, watchEnabled, buildJavaArgs } = launcher;

test('parses the major version from java -version output of old and new JDKs', () => {
    assert.equal(parseJavaMajor('openjdk version "21.0.2" 2024-01-16\nOpenJDK Runtime Environment'), 21);
    assert.equal(parseJavaMajor('java version "1.8.0_392"\nJava(TM) SE Runtime Environment'), 8);
    assert.equal(parseJavaMajor('openjdk version "25" 2025-09-16'), 25);
    assert.equal(parseJavaMajor('openjdk version "17.0.10" 2024-01-16 LTS'), 17);
    assert.equal(parseJavaMajor(''), null);
    assert.equal(parseJavaMajor('bash: java: command not found'), null);
});

test('candidates are tried most specific first: SPRING_TOOLS_JAVA, JAVA_HOME, then PATH', () => {
    const all = javaCandidates({ SPRING_TOOLS_JAVA: '/opt/jdk/bin/java', JAVA_HOME: '/usr/lib/jvm/17' }, 'linux');
    assert.deepEqual(all.map((c) => c.source), ['SPRING_TOOLS_JAVA', 'JAVA_HOME', 'PATH']);
    assert.equal(all[1].java, join('/usr/lib/jvm/17', 'bin', 'java'));
    assert.deepEqual(javaCandidates({}, 'linux').map((c) => c.java), ['java']);
    assert.ok(javaCandidates({ JAVA_HOME: 'C:\\jdk' }, 'win32')[0].java.endsWith('java.exe'));
});

test('picks the first candidate that is Java 21 or newer and skips older or broken ones', () => {
    const versions = { '/old/bin/java': 'openjdk version "17.0.10"', java: 'openjdk version "21.0.2"', '/new/bin/java': 'openjdk version "25"' };
    const probe = (java) => (java in versions ? { output: versions[java] } : { output: '', error: 'ENOENT' });
    const picked = pickJava(javaCandidates({ JAVA_HOME: '/old', SPRING_TOOLS_JAVA: '/missing/java' }, 'linux'), probe);
    assert.equal(picked.java, 'java');
    assert.equal(picked.major, 21);
    assert.deepEqual(picked.tried.map((t) => [t.source, t.major, t.error ?? null]), [
        ['SPRING_TOOLS_JAVA', null, 'ENOENT'],
        ['JAVA_HOME', 17, null],
        ['PATH', 21, null],
    ]);
    assert.equal(pickJava(javaCandidates({ SPRING_TOOLS_JAVA: '/new/bin/java' }, 'linux'), probe).major, 25);
});

test('negative control: no usable Java yields no pick but a full record of what was tried', () => {
    const picked = pickJava(javaCandidates({ JAVA_HOME: '/old' }, 'linux'), () => ({ output: 'openjdk version "17.0.1"' }));
    assert.equal(picked.java, null);
    assert.equal(picked.tried.length, 2);
    assert.ok(picked.tried.every((t) => t.major === 17 && t.major < MIN_JAVA_MAJOR));
});

test('splits SPRING_TOOLS_JAVA_OPTS like a shell would', () => {
    assert.deepEqual(splitOpts(undefined), []);
    assert.deepEqual(splitOpts('  -Xmx2g   -XX:+UseZGC '), ['-Xmx2g', '-XX:+UseZGC']);
    assert.deepEqual(splitOpts('-Dfoo="a b" -Dbar=\'c d\''), ['-Dfoo=a b', '-Dbar=c d']);
});

test('JVM arguments put user options after the defaults so they win, and end with -jar <path>', () => {
    const args = buildJavaArgs({ jarPath: '/p/ls.jar', dataDir: '/data', projectDir: '/proj', extraOpts: ['-Xmx2g'] });
    assert.ok(args.indexOf('-Xmx1024m') < args.indexOf('-Xmx2g'));
    assert.deepEqual(args.slice(-2), ['-jar', '/p/ls.jar']);
    assert.ok(args.includes('-Dspring.ai.mcp.server.stdio=true'));
    assert.ok(args.includes('-Dlanguageserver.enabled=false'));
    assert.ok(args.includes('-Dspring.boot.ls.project.dir=/proj'));
    assert.ok(args.includes(`-Dlogging.file.name=${join('/data', 'boot-ls.log')}`));
    assert.ok(args.includes(`-Dspring.ai.mcp.server.instructions=${SERVER_INSTRUCTIONS}`));
});

test('the file watcher is on by default and SPRING_TOOLS_LS_WATCH=false turns it off', () => {
    const base = { jarPath: '/p/ls.jar', dataDir: '/data', projectDir: '/proj' };
    assert.ok(buildJavaArgs(base).includes('-Dspring.boot.ls.project.watch=true'));
    assert.ok(buildJavaArgs({ ...base, watch: false }).includes('-Dspring.boot.ls.project.watch=false'));
    for (const value of [undefined, '', 'true', 'yes', '1']) {
        assert.equal(watchEnabled(value), true, `watchEnabled(${JSON.stringify(value)})`);
    }
    for (const value of ['false', 'FALSE', ' 0 ', 'no', 'off']) {
        assert.equal(watchEnabled(value), false, `watchEnabled(${JSON.stringify(value)})`);
    }
    // The property must precede user options so SPRING_TOOLS_JAVA_OPTS can still override it.
    const args = buildJavaArgs({ ...base, extraOpts: ['-Dspring.boot.ls.project.watch=false'] });
    assert.ok(args.indexOf('-Dspring.boot.ls.project.watch=true') < args.lastIndexOf('-Dspring.boot.ls.project.watch=false'));
});

test('server instructions name the entry-point tools and stay under the 2 KB Claude Code truncation limit', () => {
    for (const tool of ['getProjectList', 'getProjectDiagnostics', 'fileChanged', 'refreshWorkspace', 'getBeanDetails', 'getRequestMappings']) {
        assert.ok(SERVER_INSTRUCTIONS.includes(tool), `${tool} should be mentioned`);
    }
    // Each skill the instructions point to must exist, so the hint never dangles after a rename.
    for (const skill of SERVER_INSTRUCTIONS.matchAll(/\/spring-tools:([\w-]+)/g)) {
        assert.ok(existsSync(join(pluginRoot, 'skills', skill[1], 'SKILL.md')), `skill ${skill[1]} referenced by the instructions is missing`);
    }
    assert.ok(SERVER_INSTRUCTIONS.includes('watches'), 'Claude should know it need not notify the server about every edit');
    assert.ok(Buffer.byteLength(SERVER_INSTRUCTIONS, 'utf8') < 2048);
    assert.ok(!/["\n]/.test(SERVER_INSTRUCTIONS), 'quotes and newlines would complicate argv quoting on Windows');
});

test('the launcher fails fast with an actionable message when no Java 21+ runtime is available', () => {
    const emptyBin = mkdtempSync(join(tmpdir(), 'spring-tools-nojava-'));
    try {
        const result = spawnSync(process.execPath, [join(pluginRoot, 'launcher.js')], {
            encoding: 'utf8',
            timeout: 30000,
            env: { PATH: emptyBin, HOME: emptyBin, CLAUDE_PROJECT_DIR: emptyBin, CLAUDE_PLUGIN_DATA: emptyBin },
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /No Java 21\+ runtime found/);
        assert.match(result.stderr, /JAVA_HOME or SPRING_TOOLS_JAVA/);
        assert.equal(result.stdout, '', 'stdout is the MCP channel and must stay silent');
    } finally {
        rmSync(emptyBin, { recursive: true, force: true });
    }
});
