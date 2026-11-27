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

const LOCK_STALE_MS = 30 * 60 * 1000;
const LOCK_WAIT_MAX_MS = 20 * 60 * 1000;
const LOCK_POLL_MS = 500;

/**
 * @param {unknown} error
 * @returns {string | undefined}
 */
function errorCode(error) {
    return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates <jar>.lock exclusively; waits while another installer holds it, breaks stale locks.
 * @param {string} lockPath
 */
async function acquireLock(lockPath) {
    const started = Date.now();
    for (;;) {
        try {
            fs.writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
            return () => { try { fs.unlinkSync(lockPath); } catch { /* already gone */ } };
        } catch (error) {
            if (errorCode(error) !== 'EEXIST') {
                throw error;
            }
        }
        try {
            const lock = fs.statSync(lockPath);
            const ownerPid = Number(fs.readFileSync(lockPath, 'utf8').trim().split(/\s+/, 1)[0]);
            const hasOwnerPid = Number.isSafeInteger(ownerPid) && ownerPid > 0;
            let ownerAlive = false;
            if (hasOwnerPid) {
                try {
                    process.kill(ownerPid, 0);
                    ownerAlive = true;
                } catch (ownerError) {
                    const code = errorCode(ownerError);
                    if (code === 'EPERM') {
                        ownerAlive = true;
                    } else if (code !== 'ESRCH') {
                        throw ownerError;
                    }
                }
            }
            if ((hasOwnerPid && !ownerAlive) || Date.now() - lock.mtimeMs > LOCK_STALE_MS) {
                fs.unlinkSync(lockPath);
                continue;
            }
        } catch (lockError) {
            if (errorCode(lockError) !== 'ENOENT') {
                throw lockError;
            }
        }
        if (Date.now() - started > LOCK_WAIT_MAX_MS) {
            throw new Error(`Gave up waiting for another installer holding ${lockPath}`);
        }
        await sleep(LOCK_POLL_MS);
    }
}

/**
 * @param {string} dir
 * @param {string} jarName
 */
function removeStalePartials(dir, jarName) {
    for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith(jarName) && entry.endsWith('.part')) {
            try { fs.unlinkSync(path.join(dir, entry)); } catch { /* best effort */ }
        }
    }
}

module.exports = { acquireLock, removeStalePartials };
