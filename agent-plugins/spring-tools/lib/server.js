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
const { spawn } = require('child_process');
const { ensureJar, defaultInstallDir } = require('./installer');
const { JAR_NAME } = require('./download');
const { MIN_JAVA_MAJOR, javaCandidates, pickJava, describeTried, splitOpts, watchEnabled } = require('./java');
const { resolveDataDir, resolveProjectDir } = require('./project-directory');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

// Shown to the client alongside the tool names when MCP tool search defers the full tool list.
const SERVER_INSTRUCTIONS = [
    'Spring Tools language server for the Spring Boot projects in this workspace.',
    'Start with getProjectList (use the projectName field, location is the project root directory; retry while the list is still empty right after startup, the project model is being resolved).',
    'getProjectDiagnostics reports Spring-specific problems with a code such as JAVA_PUBLIC_BEAN_METHOD; every code has a fix playbook. Use the quickfix skill when available, or read the matching explanations/<CODE>.md file, then validate the project with the validate skill or getProjectDiagnostics.',
    'Bean wiring: getBeanDetails, findBeansByType, getBeanUsageInfo. Endpoints: getRequestMappings, findRequestMappingsByMethod. Build facts: getSpringBootVersion, getJavaVersion, getResolvedProjectClasspath.',
    'Architecture: getLogicalStructure, getStereotypesList, findComponentsByStereotype and the logical-structure baseline tools. Spring versions and support: getReleases, getGenerations, getUpcomingReleases, getLatestReleaseInformation.',
    'For guidance, use the quickfix or validate Spring Tools skill when available.',
    'The server watches the workspace directory, so edits, new files and new projects are picked up within a second without any notification; call fileChanged/fileDeleted only when a change might have been missed and refreshWorkspace when the index looks stale (e.g. after a large git checkout).',
].join(' ');

/**
 * Server instructions with the absolute location of the fix playbooks appended. Clients that do not
 * substitute path placeholders in skill and agent files learn where the playbooks are this way.
 * @param {string} [pluginRoot]
 */
function serverInstructions(pluginRoot = PLUGIN_ROOT) {
    return `${SERVER_INSTRUCTIONS} The fix playbooks are the <CODE>.md files in ${path.join(pluginRoot, 'explanations')}.`;
}

/** @param {{jarPath: string, dataDir: string, projectDir: string, watch?: boolean, extraOpts?: string[], instructions?: string}} options */
function buildJavaArgs({ jarPath, dataDir, projectDir, watch = true, extraOpts = [], instructions = serverInstructions() }) {
    return [
        '-Xmx1024m',
        '-Djdk.util.zip.disableZip64ExtraFieldValidation=true',
        '-Dspring.config.location=classpath:/application.properties',
        '-Dspring.profiles.active=file-logging',
        `-Dlogging.file.name=${path.join(dataDir, 'boot-ls.log')}`,
        '-Dlogging.level.root=INFO',
        '-Dspring.ai.mcp.server.stdio=true',
        `-Dspring.ai.mcp.server.instructions=${instructions}`,
        // Only the MCP tools are exposed over stdio; nothing connects to the LSP transport.
        '-Dlanguageserver.enabled=false',
        `-Dlanguageserver.standalone.project-dir=${projectDir}`,
        // The server follows on-disk changes under the project dir itself (java.nio WatchService).
        `-Dlanguageserver.standalone.filewatcher.enabled=${watch ? 'true' : 'false'}`,
        ...extraOpts,
        '-jar',
        jarPath,
    ];
}

/** @param {(line: string) => void} log */
async function resolveJar(log) {
    if (process.env.SPRING_TOOLS_LS_JAR) {
        const jarPath = path.resolve(process.env.SPRING_TOOLS_LS_JAR);
        if (!fs.existsSync(jarPath)) {
            throw new Error(`SPRING_TOOLS_LS_JAR points to a missing file: ${jarPath}`);
        }
        log(`Using language server JAR from SPRING_TOOLS_LS_JAR: ${jarPath}`);
        return jarPath;
    }
    const jarDest = defaultInstallDir(PLUGIN_ROOT);
    const jarPath = path.join(jarDest, JAR_NAME);
    if (!fs.existsSync(jarPath)) {
        log(`${JAR_NAME} not found, downloading it (first start of this plugin version). If the client reports the MCP server as failed before the download finishes, reconnect it after the download completes.`);
    }
    return (await ensureJar({ pluginRoot: PLUGIN_ROOT, dest: jarDest, ifMissing: true, log })).jarPath;
}

async function start() {
    /** @param {string} line */
    const log = (line) => console.error(`[spring-tools] ${line}`);
    // The plugin root changes on every plugin update, so runtime state such as the log file goes to
    // the persistent data dir both clients export (PLUGIN_DATA is the Agent Plugins spelling).
    const project = resolveProjectDir();
    const dataDir = resolveDataDir();
    if (project.detected) {
        log(`Indexing ${project.dir} (from ${project.source})`);
    } else {
        throw new Error(`Could not determine the workspace directory; refusing to index the plugin directory ${project.dir}. Set SPRING_TOOLS_PROJECT_DIR in the MCP server environment to the workspace root. For Codex, configure the server env explicitly; exporting a variable in the parent shell may not forward it.`);
    }

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
    const javaArgs = buildJavaArgs({ jarPath, dataDir, projectDir: project.dir, watch, extraOpts: splitOpts(process.env.SPRING_TOOLS_JAVA_OPTS) });
    const child = spawn(picked.java, javaArgs, { stdio: 'inherit', windowsHide: true });

    // The client terminates this launcher when the session ends; forward that to the JVM so it
    // does not linger as an orphan. The server shuts down gracefully within about a second.
    /** @type {NodeJS.Signals | null} */
    let shutdownSignal = null;
    /** @type {NodeJS.Timeout | undefined} */
    let forceKillTimer;
    /** @type {NodeJS.Signals[]} */
    const shutdownSignals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
    for (const signal of shutdownSignals) {
        process.once(signal, () => {
            shutdownSignal = signal;
            if (!child.killed) {
                child.kill('SIGTERM');
            }
            // Give the language server time to flush logs and release workspace resources.
            forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
            forceKillTimer.unref();
        });
    }

    child.on('error', (error) => {
        log(`Failed to start the Java process: ${error.message}`);
        process.exit(1);
    });
    child.on('close', (code, signal) => {
        clearTimeout(forceKillTimer);
        if (shutdownSignal) {
            process.exit(0);
        } else if (code !== 0) {
            log(`Language server exited with ${signal ? `signal ${signal}` : `code ${code}`}; see ${path.join(dataDir, 'boot-ls.log')}`);
        }
        process.exit(code ?? 1);
    });
}

module.exports = { SERVER_INSTRUCTIONS, serverInstructions, buildJavaArgs, start };
