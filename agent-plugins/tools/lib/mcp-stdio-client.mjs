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

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** Starts launcher.js and provides its newline-delimited JSON-RPC stdio interface. */
export function startMcpStdioClient({ pluginDir, workspace, dataDir, inheritStderr = false }) {
    const child = spawn(process.execPath, [join(pluginDir, 'launcher.js')], {
        env: { ...process.env, CLAUDE_PROJECT_DIR: workspace, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_PLUGIN_ROOT: pluginDir },
        stdio: ['pipe', 'pipe', inheritStderr ? 'inherit' : 'pipe'],
    });
    const childExited = new Promise((resolvePromise) => child.once('exit', resolvePromise));
    const pending = new Map();
    const strayStdout = [];
    let nextId = 1;
    let stderr = '';

    if (!inheritStderr) {
        child.stderr.on('data', (chunk) => { stderr += chunk; });
    }
    createInterface({ input: child.stdout }).on('line', (line) => {
        if (!line.trim()) return;
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            strayStdout.push(line);
            return;
        }
        if (message.id !== undefined && pending.has(message.id)) {
            pending.get(message.id)(message);
            pending.delete(message.id);
        }
    });

    function request(method, params, timeoutMs = 120000) {
        const id = nextId++;
        return new Promise((resolvePromise, reject) => {
            const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method} (id ${id})`)), timeoutMs);
            pending.set(id, (message) => {
                clearTimeout(timer);
                resolvePromise(message);
            });
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });
    }

    function notify(method, params) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    }

    async function call(name, toolArgs = {}) {
        const response = await request('tools/call', { name, arguments: toolArgs });
        return {
            response,
            text: (response.result?.content ?? []).map((content) => content.text ?? JSON.stringify(content)).join('\n'),
        };
    }

    return {
        child,
        childExited,
        request,
        notify,
        call,
        strayStdout,
        get stderr() { return stderr; },
    };
}
