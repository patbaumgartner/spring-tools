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
// Starts the standalone Spring Boot language server as an MCP stdio server for Claude Code,
// GitHub Copilot CLI, Codex and OpenCode.
// Environment (all optional):
//   SPRING_TOOLS_JAVA        java executable to use (else $JAVA_HOME/bin/java, else java on PATH; first with Java 21+ wins)
//   SPRING_TOOLS_JAVA_OPTS   extra JVM options, e.g. "-Xmx2g" (appended after the defaults, so they override them)
//   SPRING_TOOLS_LS_JAR      path to a local language server JAR to run instead of the downloaded one
//   SPRING_TOOLS_LS_WATCH    "false" disables the built-in file watcher; use hooks or explicit change tools to update the index
//   SPRING_TOOLS_PROJECT_DIR workspace directory to index, overriding the auto-detection below
//   SPRING_TOOLS_DATA_DIR    persistent log/runtime directory (else use client data dir or ~/.spring-tools/data)
// @ts-check
'use strict';

const { SERVER_INSTRUCTIONS, serverInstructions, buildJavaArgs, start } = require('./lib/server');
const { MIN_JAVA_MAJOR, parseJavaMajor, javaCandidates, pickJava, splitOpts, watchEnabled } = require('./lib/java');
const { resolveProjectDir, resolveDataDir } = require('./lib/project-directory');

if (require.main === module) {
    start().catch((error) => {
        console.error(`[spring-tools] ${error.message}`);
        process.exit(1);
    });
}

module.exports = { MIN_JAVA_MAJOR, SERVER_INSTRUCTIONS, serverInstructions, parseJavaMajor, javaCandidates, pickJava, splitOpts, watchEnabled, buildJavaArgs, resolveProjectDir, resolveDataDir };
