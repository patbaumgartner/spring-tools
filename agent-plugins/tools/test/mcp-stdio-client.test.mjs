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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { startMcpStdioClient } from '../lib/mcp-stdio-client.mjs';

const clients = [];
const roots = [];

afterEach(async () => {
    await Promise.all(clients.splice(0).map(async (client) => {
        client.child.kill('SIGTERM');
        await client.childExited;
    }));
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function startFakeClient() {
    const root = mkdtempSync(join(tmpdir(), 'spring-tools-mcp-client-'));
    const pluginDir = join(root, 'plugin');
    const workspace = join(root, 'workspace');
    const dataDir = join(root, 'data');
    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(pluginDir, 'launcher.js'), `
        const { createInterface } = require('node:readline');
        console.error('fake launcher ready');
        console.log('non-JSON output');
        createInterface({ input: process.stdin }).on('line', (line) => {
            const message = JSON.parse(line);
            if (message.method === 'hang') return;
            if (message.method === 'notifications/initialized') return;
            const result = message.method === 'tools/call'
                ? { content: [{ type: 'text', text: 'called ' + message.params.name }] }
                : { serverInfo: { name: 'fake' } };
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
        });
    `);
    const client = startMcpStdioClient({ pluginDir, workspace, dataDir });
    clients.push(client);
    roots.push(root);
    return client;
}

test('MCP stdio client exchanges requests and tool calls while preserving transport diagnostics', async () => {
    const client = startFakeClient();
    const initialized = await client.request('initialize', {});
    assert.equal(initialized.result.serverInfo.name, 'fake');
    client.notify('notifications/initialized', {});
    const called = await client.call('getProjectList');
    assert.equal(called.text, 'called getProjectList');
    assert.deepEqual(client.strayStdout, ['non-JSON output']);
    assert.match(client.stderr, /fake launcher ready/);
});

test('MCP stdio client rejects a request that exceeds its timeout', async () => {
    const client = startFakeClient();
    await assert.rejects(client.request('hang', {}, 20), /timeout waiting for hang \(id 1\)/);
});
