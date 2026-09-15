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
// Starts the standalone Spring Boot language server as an MCP stdio server for Claude Code.
// Environment (all optional):
//   SPRING_TOOLS_JAVA       java executable to use (else $JAVA_HOME/bin/java, else java on PATH; first with Java 21+ wins)
//   SPRING_TOOLS_JAVA_OPTS  extra JVM options, e.g. "-Xmx2g" (appended after the defaults, so they override them)
//   SPRING_TOOLS_LS_JAR     path to a local language server JAR to run instead of the downloaded one
//   SPRING_TOOLS_LS_WATCH   "false" disables the built-in file watcher (the hooks then remain the only way the index learns about changes)
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ensureJar, JAR_NAME } = require('./install.js');

const MIN_JAVA_MAJOR = 21;

// Shown to Claude alongside the tool names when MCP tool search defers the full tool list.
const SERVER_INSTRUCTIONS = [
    'Spring Tools language server for the Spring Boot projects in this workspace.',
    'Start with getProjectList (use the projectName field, location is the project root directory; retry while the list is still empty right after startup, the project model is being resolved).',
    'getProjectDiagnostics reports Spring-specific problems with a code such as JAVA_PUBLIC_BEAN_METHOD; every code has a fix playbook, apply it with the /spring-tools:quickfix skill and validate whole projects with /spring-tools:validate.',
    'Bean wiring: getBeanDetails, findBeansByType, getBeanUsageInfo. Endpoints: getRequestMappings, findRequestMappingsByMethod. Build facts: getSpringBootVersion, getJavaVersion, getResolvedProjectClasspath.',
    'Architecture: getLogicalStructure, getStereotypesList, findComponentsByStereotype and the logical-structure baseline tools. Spring versions and support: getReleases, getGenerations, getUpcomingReleases, getLatestReleaseInformation.',
    'Architecture and structure questions: /spring-tools:architecture; bean wiring: /spring-tools:beans; endpoints: /spring-tools:endpoints; build facts: /spring-tools:project-info; release and support dates: /spring-tools:spring-versions.',
    'The server watches the workspace directory, so edits, new files and new projects are picked up within a second without any notification; call fileChanged/fileDeleted only when a change might have been missed and refreshWorkspace when the index looks stale (e.g. after a large git checkout).',
].join(' ');

/** Major Java version from `java -version` output; null when unparseable. */
function parseJavaMajor(output) {
    const match = /version "(\d+)(?:\.(\d+))?/.exec(output || '');
    if (!match) {
        return null;
    }
    const major = Number(match[1]);
    return major === 1 ? Number(match[2]) : major;
}

/** Java executables to try, most specific first. */
function javaCandidates(env = process.env, platform = process.platform) {
    const exe = platform === 'win32' ? 'java.exe' : 'java';
    const candidates = [];
    if (env.SPRING_TOOLS_JAVA) {
        candidates.push({ java: env.SPRING_TOOLS_JAVA, source: 'SPRING_TOOLS_JAVA' });
    }
    if (env.JAVA_HOME) {
        candidates.push({ java: path.join(env.JAVA_HOME, 'bin', exe), source: 'JAVA_HOME' });
    }
    candidates.push({ java: 'java', source: 'PATH' });
    return candidates;
}

function probeJava(java) {
    const result = spawnSync(java, ['-version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (result.error) {
        return { output: '', error: result.error.message };
    }
    return { output: `${result.stderr || ''}${result.stdout || ''}` };
}

/** First candidate that runs and reports Java >= MIN_JAVA_MAJOR, plus what was tried. */
function pickJava(candidates, probe = probeJava) {
    const tried = [];
    for (const candidate of candidates) {
        const probed = probe(candidate.java);
        const major = probed.error ? null : parseJavaMajor(probed.output);
        tried.push({ ...candidate, major, error: probed.error });
        if (major !== null && major >= MIN_JAVA_MAJOR) {
            return { ...candidate, major, tried };
        }
    }
    return { java: null, major: null, tried };
}

function describeTried(tried) {
    return tried.map((t) => `${t.java} (${t.source}): ${t.error ? t.error : t.major === null ? 'no version reported' : `Java ${t.major}`}`).join('; ');
}

/** Splits a JVM options string on whitespace, honoring single/double quotes (also inside a token). */
function splitOpts(value) {
    const opts = [];
    let current = '';
    let quote = null;
    let inToken = false;
    for (const char of value || '') {
        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
        } else if (char === '"' || char === "'") {
            quote = char;
            inToken = true;
        } else if (/\s/.test(char)) {
            if (inToken) {
                opts.push(current);
            }
            current = '';
            inToken = false;
        } else {
            current += char;
            inToken = true;
        }
    }
    if (inToken) {
        opts.push(current);
    }
    return opts;
}

/** true unless SPRING_TOOLS_LS_WATCH is set to false/0/no/off (case-insensitive). */
function watchEnabled(value) {
    return !/^\s*(false|0|no|off)\s*$/i.test(value || '');
}

function buildJavaArgs({ jarPath, dataDir, projectDir, watch = true, extraOpts = [] }) {
    return [
        '-Xmx1024m',
        '-Djdk.util.zip.disableZip64ExtraFieldValidation=true',
        '-Dspring.config.location=classpath:/application.properties',
        '-Dspring.profiles.active=file-logging',
        `-Dlogging.file.name=${path.join(dataDir, 'boot-ls.log')}`,
        '-Dlogging.level.root=INFO',
        '-Dspring.ai.mcp.server.stdio=true',
        `-Dspring.ai.mcp.server.instructions=${SERVER_INSTRUCTIONS}`,
        // Only the MCP tools are exposed over stdio; nothing connects to the LSP transport.
        '-Dlanguageserver.enabled=false',
        `-Dspring.boot.ls.project.dir=${projectDir}`,
        // The server follows on-disk changes under the project dir itself (java.nio WatchService).
        `-Dspring.boot.ls.project.watch=${watch ? 'true' : 'false'}`,
        ...extraOpts,
        '-jar',
        jarPath,
    ];
}

async function resolveJar(log) {
    if (process.env.SPRING_TOOLS_LS_JAR) {
        const jarPath = path.resolve(process.env.SPRING_TOOLS_LS_JAR);
        if (!fs.existsSync(jarPath)) {
            throw new Error(`SPRING_TOOLS_LS_JAR points to a missing file: ${jarPath}`);
        }
        log(`Using language server JAR from SPRING_TOOLS_LS_JAR: ${jarPath}`);
        return jarPath;
    }
    const jarPath = path.join(__dirname, 'language-server', JAR_NAME);
    if (!fs.existsSync(jarPath)) {
        log(`${JAR_NAME} not found, downloading it (first start of this plugin version). If Claude Code reports the MCP server as failed before the download finishes, reconnect it from /mcp.`);
    }
    return (await ensureJar({ pluginRoot: __dirname, ifMissing: true, log })).jarPath;
}

async function start() {
    const log = (line) => console.error(`[spring-tools] ${line}`);
    // Claude Code exports these to plugin MCP servers. The plugin root changes on every plugin
    // update, so runtime state such as the log file goes to the persistent data dir.
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const dataDir = process.env.CLAUDE_PLUGIN_DATA || __dirname;

    const picked = pickJava(javaCandidates());
    if (!picked.java) {
        throw new Error(`No Java ${MIN_JAVA_MAJOR}+ runtime found. Tried: ${describeTried(picked.tried)}. Install a JDK 21 or newer and put it on PATH, or point JAVA_HOME or SPRING_TOOLS_JAVA at it.`);
    }
    log(`Using Java ${picked.major} from ${picked.java} (${picked.source})`);

    const jarPath = await resolveJar(log);
    fs.mkdirSync(dataDir, { recursive: true });
    const watch = watchEnabled(process.env.SPRING_TOOLS_LS_WATCH);
    if (!watch) {
        log('File watcher disabled by SPRING_TOOLS_LS_WATCH; the index only follows the plugin hooks and explicit fileChanged/refreshWorkspace calls.');
    }
    const javaArgs = buildJavaArgs({ jarPath, dataDir, projectDir, watch, extraOpts: splitOpts(process.env.SPRING_TOOLS_JAVA_OPTS) });
    const child = spawn(picked.java, javaArgs, { stdio: 'inherit', windowsHide: true });

    // Claude Code terminates this launcher when the session ends; forward that to the JVM so it
    // does not linger as an orphan. The server shuts down gracefully within about a second.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGQUIT']) {
        process.on(signal, () => {
            if (!child.killed) {
                child.kill('SIGTERM');
            }
            process.exit(0);
        });
    }

    child.on('error', (error) => {
        log(`Failed to start the Java process: ${error.message}`);
        process.exit(1);
    });
    child.on('close', (code, signal) => {
        if (code !== 0) {
            log(`Language server exited with ${signal ? `signal ${signal}` : `code ${code}`}; see ${path.join(dataDir, 'boot-ls.log')}`);
        }
        process.exit(code ?? 1);
    });
}

if (require.main === module) {
    start().catch((error) => {
        console.error(`[spring-tools] ${error.message}`);
        process.exit(1);
    });
}

module.exports = { MIN_JAVA_MAJOR, SERVER_INSTRUCTIONS, parseJavaMajor, javaCandidates, pickJava, splitOpts, watchEnabled, buildJavaArgs };