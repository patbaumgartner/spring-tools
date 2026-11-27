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

const path = require('path');
const { spawnSync } = require('child_process');

const MIN_JAVA_MAJOR = 21;

/** @typedef {{java: string, source: string}} JavaCandidate */
/** @typedef {JavaCandidate & {major: number | null, error: string | undefined}} JavaAttempt */
/** @typedef {{java: string | null, source?: string, major: number | null, tried: JavaAttempt[]}} JavaSelection */

/**
 * Major Java version from `java -version` output; null when unparseable.
 * @param {string | null | undefined} output
 */
function parseJavaMajor(output) {
    const match = /version "(\d+)(?:\.(\d+))?/.exec(output || '');
    if (!match) {
        return null;
    }
    const major = Number(match[1]);
    return major === 1 ? Number(match[2]) : major;
}

/**
 * Java executables to try, most specific first.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {JavaCandidate[]}
 */
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

/**
 * @param {string} java
 * @returns {{output: string, error?: string}}
 */
function probeJava(java) {
    const result = spawnSync(java, ['-version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (result.error) {
        return { output: '', error: result.error.message };
    }
    return { output: `${result.stderr || ''}${result.stdout || ''}` };
}

/**
 * First candidate that runs and reports Java >= MIN_JAVA_MAJOR, plus what was tried.
 * @param {JavaCandidate[]} candidates
 * @param {(java: string) => {output: string, error?: string}} [probe]
 * @returns {JavaSelection}
 */
function pickJava(candidates, probe = probeJava) {
    /** @type {JavaAttempt[]} */
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

/** @param {JavaAttempt[]} tried */
function describeTried(tried) {
    return tried.map((t) => `${t.java} (${t.source}): ${t.error ? t.error : t.major === null ? 'no version reported' : `Java ${t.major}`}`).join('; ');
}

/**
 * Splits a JVM options string on whitespace, honoring single/double quotes (also inside a token).
 * @param {string | null | undefined} value
 */
function splitOpts(value) {
    /** @type {string[]} */
    const opts = [];
    let current = '';
    /** @type {string | null} */
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

/**
 * true unless SPRING_TOOLS_LS_WATCH is set to false/0/no/off (case-insensitive).
 * @param {string | null | undefined} value
 */
function watchEnabled(value) {
    return !/^\s*(false|0|no|off)\s*$/i.test(value || '');
}

module.exports = {
    MIN_JAVA_MAJOR,
    parseJavaMajor,
    javaCandidates,
    pickJava,
    describeTried,
    splitOpts,
    watchEnabled,
};
