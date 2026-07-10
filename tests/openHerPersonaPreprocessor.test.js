const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const repoRoot = path.resolve(__dirname, '..');
const pluginPath = path.join(repoRoot, 'Plugin', 'OpenHerPersona', 'OpenHerPersona.js');
const stateDbPath = path.join(repoRoot, 'Plugin', 'OpenHerPersona', 'state', 'openher-axis-state.sqlite');
const configPath = path.join(repoRoot, 'Plugin', 'OpenHerPersona', 'state', 'openher-persona-config.json');
const legacyStateDbPath = path.join(repoRoot, 'Plugin', 'OpenHerPersona', 'state', 'openher-persona-state.sqlite');
const legacyStateJsonPath = path.join(repoRoot, 'Plugin', 'OpenHerPersona', 'state', 'openher-persona-state.json');
const orderPath = path.join(repoRoot, 'preprocessor_order.json');

const TEST_PLUGIN_CONFIG = {
  DebugMode: false,
  OpenHerPersonaEnabled: true,
  OpenHerPersonaAsyncObservation: true,
  OpenHerPersonaQueueMaxSize: 64,
  OpenHerPersonaEmbeddingTimeoutMs: 2500,
  OpenHerPersonaAnchorTemperature: 0.08,
  OpenHerPersonaStateEma: 0.35,
  OpenHerPersonaDriveStateEma: 0.78,
  OpenHerPersonaCouplingStrength: 0.32,
  OpenHerPersonaDropLegacyState: true,
};

let activePluginsForCurrentTest = null;

function stateArtifacts() {
  return [
    stateDbPath,
    `${stateDbPath}-shm`,
    `${stateDbPath}-wal`,
    legacyStateDbPath,
    `${legacyStateDbPath}-shm`,
    `${legacyStateDbPath}-wal`,
    legacyStateJsonPath,
    `${legacyStateJsonPath}.tmp`,
    configPath,
  ];
}

function backupFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

function restoreFile(filePath, content) {
  if (content === null) {
    try {
      fs.unlinkSync(filePath);
    } catch (_) {
      // File did not exist.
    }
    return;
  }
  fs.writeFileSync(filePath, content);
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function stableVector(text, dimensions = 12) {
  const digest = crypto.createHash('sha256').update(String(text)).digest();
  const vector = [];
  for (let index = 0; index < dimensions; index += 1) {
    const high = digest[index];
    const low = digest[index + dimensions];
    const raw = ((high * 256) + low) / 65535;
    vector.push(Number((raw * 2 - 1).toFixed(6)));
  }
  return vector;
}

function createEmbeddingProvider({ nullVectors = false } = {}) {
  return async (texts) => {
    if (!Array.isArray(texts)) return null;
    if (nullVectors) return texts.map(() => null);
    return texts.map((text) => stableVector(text));
  };
}

function createSplitEmbeddingProvider() {
  let anchorCalls = 0;
  let messageCalls = 0;
  let releaseQueued = false;
  let pendingMessageResolver = null;

  const provider = async (texts) => {
    if (!Array.isArray(texts)) return null;
    if (texts.length > 1) {
      anchorCalls += 1;
      return texts.map((text) => stableVector(text));
    }

    messageCalls += 1;
    return new Promise((resolve) => {
      const complete = () => resolve(texts.map((text) => stableVector(text)));
      if (releaseQueued) {
        releaseQueued = false;
        complete();
        return;
      }
      pendingMessageResolver = complete;
    });
  };

  return {
    provider,
    releasePendingMessage() {
      if (pendingMessageResolver) {
        const complete = pendingMessageResolver;
        pendingMessageResolver = null;
        complete();
        return true;
      }
      releaseQueued = true;
      return false;
    },
    get calls() {
      return { anchorCalls, messageCalls };
    },
  };
}

function freshPlugin(config = {}, dependencies = {}) {
  delete require.cache[require.resolve(pluginPath)];
  const plugin = require(pluginPath);
  plugin.initialize({
    ...TEST_PLUGIN_CONFIG,
    ...config,
  }, dependencies);
  if (activePluginsForCurrentTest) {
    activePluginsForCurrentTest.push(plugin);
  }
  return plugin;
}

async function withRestoredState(fn) {
  const artifacts = stateArtifacts();
  const backups = Object.fromEntries(artifacts.map((filePath) => [filePath, backupFile(filePath)]));
  const previousActivePlugins = activePluginsForCurrentTest;
  const activePlugins = [];
  activePluginsForCurrentTest = activePlugins;
  try {
    for (const filePath of artifacts) {
      restoreFile(filePath, null);
    }
    await fn();
  } finally {
    for (const plugin of activePlugins.reverse()) {
      if (plugin && typeof plugin.shutdown === 'function') {
        plugin.shutdown();
      }
    }
    activePluginsForCurrentTest = previousActivePlugins;
    for (const [filePath, content] of Object.entries(backups)) {
      restoreFile(filePath, content);
    }
  }
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (lastError) throw lastError;
  throw new Error('Timed out waiting for condition');
}

function readAxisStoreFromDb() {
  if (!fs.existsSync(stateDbPath)) return null;
  const db = new Database(stateDbPath, { readonly: true });
  try {
    const metaRows = db.prepare('SELECT key, value FROM openher_axis_meta').all();
    const meta = Object.fromEntries(metaRows.map((row) => [row.key, row.value]));
    const rows = db.prepare('SELECT * FROM openher_axis_state ORDER BY agent_key ASC').all();
    const agents = {};
    for (const row of rows) {
      agents[row.agent_key] = {
        agentKey: row.agent_key,
        agentLabel: row.agent_label,
        psyGender: Number(row.psy_gender),
        gender: parseJson(row.gender_json, {}),
        cognitive: parseJson(row.cognitive_json, {}),
        affective: parseJson(row.affective_json, {}),
        drive: parseJson(row.drive_json, {}),
        coupling: parseJson(row.coupling_json, {}),
        baseline: parseJson(row.baseline_json, {}),
        observationCount: Number(row.observation_count) || 0,
        lastObservedAt: row.last_observed_at || null,
        lastInputHash: row.last_input_hash || null,
        lastObservation: parseJson(row.last_observation_json, null),
        updatedAt: row.updated_at,
        createdAt: row.created_at,
      };
    }
    const anchorRows = db.prepare('SELECT COUNT(*) AS count FROM openher_axis_anchors').get().count;
    const auditRows = db.prepare('SELECT COUNT(*) AS count FROM openher_axis_audit').get().count;
    return {
      meta,
      agents,
      counts: {
        stateRows: rows.length,
        anchorRows,
        auditRows,
      },
    };
  } finally {
    db.close();
  }
}

function readAgentState(agentKey) {
  const store = readAxisStoreFromDb();
  return store && store.agents ? store.agents[agentKey] || null : null;
}

function assertAxisStateShape(state) {
  assert(state);
  assert.equal(typeof state.agentKey, 'string');
  assert.equal(typeof state.agentLabel, 'string');
  assert.equal(typeof state.psyGender, 'number');
  assert(state.gender && typeof state.gender === 'object');
  assert(state.cognitive && typeof state.cognitive === 'object');
  assert(state.affective && typeof state.affective === 'object');
  assert(state.drive && typeof state.drive === 'object');
  assert(state.baseline && typeof state.baseline === 'object');
  assert(state.baseline.axes && typeof state.baseline.axes === 'object');
  assert(state.baseline.axes.psy_gender, 'missing psy_gender baseline axis');
  assert.equal(typeof state.observationCount, 'number');
}

function oneRingSystem(agent, tail = 'base system') {
  return `[[OneRing::${agent}::VCPChat]]\n${tail}`;
}

function virtualUserNotice(agent = 'Nova', client = 'VCPChat') {
  return `[系统提示:][OneRing通知:上一条消息由${agent}于2026-06-10 12:00:00发送于${client}]`;
}

test('OpenHerPersona observer suite', async (t) => {
await t.test('OpenHerPersona status and explain report observer-only boundaries', async () => {
  await withRestoredState(async () => {
    const plugin = freshPlugin();
    await plugin.processToolCall({ command: 'reset', agentId: 'Nova', agentName: 'Nova' });

    const status = await plugin.processToolCall({ command: 'status', agentId: 'Nova', agentName: 'Nova' });
    assert.equal(status.mode, 'async_observer');
    assert.equal(status.promptInjection, false);
    assert.equal(status.boundaries.noPromptInjection, true);
    assert.equal(status.boundaries.noPersonaDeltaProtocol, true);
    assert.equal(status.boundaries.noBrkHint, true);
    assert.equal(status.boundaries.noHtmlHint, true);
    assert.equal(status.boundaries.noTimeDecay, true);
    assert.equal(status.boundaries.noKeywordHeuristic, true);
    assert.equal(status.boundaries.noProactiveSending, true);
    assert.equal(status.boundaries.noLongTermMemoryWrites, true);
    assert.equal(status.boundaries.observationOnly, true);
    assert.equal(status.state.agentKey, 'Nova');
    assert.equal(status.state.observationCount, 0);
    assert.equal(status.database.path, stateDbPath);
    assert.equal(status.database.schema, 'openher_axis_*');
    assertAxisStateShape(status.state);

    const explain = await plugin.processToolCall({ command: 'explain' });
    assert.match(explain.summary, /pure async observation/i);
    assert(explain.removed.includes('persona_state_hint injection'));
    assert(explain.removed.includes('brk / HTML expression hints'));
    assert(explain.removed.includes('persona_delta JSON protocol'));

    const tick = await plugin.processToolCall({ command: 'tick', agentId: 'Nova', agentName: 'Nova' });
    assert.equal(tick.skipped, true);
    assert.match(tick.reason, /removed in pure async observer mode/);
    assert.equal(tick.state.agentKey, 'Nova');
    assert.equal(tick.state.observationCount, 0);
  });
});

await t.test('OpenHerPersona disabled mode returns original messages without observation', async () => {
  await withRestoredState(async () => {
    const plugin = freshPlugin({ OpenHerPersonaEnabled: false });
    const messages = [
      { role: 'system', content: oneRingSystem('Nova') },
      { role: 'user', content: 'disabled smoke' },
    ];
    const before = JSON.stringify(messages);

    const processed = await plugin.processMessages(messages, {
      vcpchatExtensions: {
        openHerPersonaAgent: { agentId: 'Nova', agentName: 'Nova' },
      },
    });

    assert.strictEqual(processed, messages);
    assert.equal(JSON.stringify(messages), before);

    const store = readAxisStoreFromDb();
    assert(store);
    assert.equal(store.counts.stateRows, 0);
    assert.equal(store.counts.anchorRows, 0);
    assert.equal(store.counts.auditRows, 0);
  });
});

await t.test('OpenHerPersona records a sync observation without mutating the payload', async () => {
  await withRestoredState(async () => {
    const plugin = freshPlugin(
      { OpenHerPersonaAsyncObservation: false },
      { embeddingProvider: createEmbeddingProvider() }
    );
    await plugin.processToolCall({ command: 'reset', agentId: 'Nova', agentName: 'Nova' });

    const messages = [
      { role: 'system', content: oneRingSystem('Nova') },
      { role: 'user', content: '短句，试试。' },
    ];
    const before = JSON.stringify(messages);

    const processed = await plugin.processMessages(messages);
    assert.strictEqual(processed, messages);
    assert.equal(JSON.stringify(messages), before);
    assert(!JSON.stringify(processed).includes('persona_state_hint'));
    assert(!JSON.stringify(processed).includes('persona_delta'));
    assert(!JSON.stringify(processed).includes('brk'));

    const status = await plugin.processToolCall({ command: 'status', agentId: 'Nova', agentName: 'Nova' });
    assert.equal(status.provider, 'injected');
    assert.equal(status.state.observationCount, 1);
    assert.equal(status.state.agentLabel, 'Nova');
    assert.equal(status.state.lastObservedAt != null, true);
    assert.equal(status.state.lastInputHash != null, true);
    assertAxisStateShape(status.state);

    const store = readAxisStoreFromDb();
    assert(store);
    assert.equal(store.counts.stateRows, 1);
    assert(store.counts.anchorRows > 0);
    assert(store.counts.auditRows >= 1);
    assert.equal(store.agents.Nova.observationCount, 1);
    assert.equal(store.agents.Nova.lastInputHash, status.state.lastInputHash);
  });
});

await t.test('OpenHerPersona resolves the latest OneRing marker and skips virtual user blocks', async () => {
  await withRestoredState(async () => {
    const plugin = freshPlugin(
      { OpenHerPersonaAsyncObservation: false },
      { embeddingProvider: createEmbeddingProvider() }
    );

    await plugin.processMessages([
      {
        role: 'system',
        content: [
          '记忆召回旧块：[[OneRing::MemoryGhost::VCPChat]]',
          '已被前置预处理器替换掉的其他占位符内容',
          '[[OneRing::Nova::VCPChat]]',
          '后续还有别的工具调用指南，不应影响 OneRing 身份识别。',
        ].join('\n'),
      },
      { role: 'user', content: '验证 system 块内部的最后一个 OneRing 身份识别。' },
    ]);

    const status = await plugin.processToolCall({ command: 'status', agentId: 'Nova', agentName: 'Nova' });
    assert.equal(status.state.agentKey, 'Nova');
    assert.equal(status.state.observationCount, 1);

    const store = readAxisStoreFromDb();
    assert(store);
    assert.equal(store.counts.stateRows, 1);
    assert(store.agents.Nova, 'missing Nova state');
    assert(!store.agents.MemoryGhost, 'older memory-like OneRing marker must not override the latest marker');

    await plugin.processMessages([
      { role: 'system', content: oneRingSystem('Nova') },
      { role: 'user', content: '真人用户消息。' },
    ]);
    const afterRealUser = readAgentState('Nova');

    await plugin.processMessages([
      { role: 'system', content: oneRingSystem('Nova') },
      { role: 'user', content: '真人用户消息。' },
      { role: 'user', content: virtualUserNotice('Nova') },
    ]);
    const afterPseudoUser = readAgentState('Nova');

    assert.equal(afterPseudoUser.observationCount, afterRealUser.observationCount);
    assert.equal(afterPseudoUser.lastInputHash, afterRealUser.lastInputHash);
  });
});

await t.test('OpenHerPersona keeps separate state buckets per agent and reset stays local', async () => {
  await withRestoredState(async () => {
    const plugin = freshPlugin(
      { OpenHerPersonaAsyncObservation: false },
      { embeddingProvider: createEmbeddingProvider() }
    );

    await plugin.processToolCall({ command: 'reset', agentId: 'nova-id', agentName: 'Nova' });
    await plugin.processToolCall({ command: 'reset', agentId: 'kira-id', agentName: 'Kira' });
    const firstNova = readAgentState('nova-id');
    const firstKira = readAgentState('kira-id');

    assert(firstNova);
    assert(firstKira);
    assert.notDeepEqual(firstNova.baseline.axes, firstKira.baseline.axes);

    await plugin.processMessages([
      { role: 'system', content: 'base system' },
      { role: 'user', content: 'Nova 的第一轮。' },
    ], {
      vcpchatExtensions: {
        openHerPersonaAgent: { agentId: 'nova-id', agentName: 'Nova' },
      },
    });

    await plugin.processMessages([
      { role: 'system', content: 'base system' },
      { role: 'user', content: 'Kira 的第一轮。' },
    ], {
      vcpchatExtensions: {
        openHerPersonaAgent: { agentId: 'kira-id', agentName: 'Kira' },
      },
    });

    let store = readAxisStoreFromDb();
    assert(store);
    assert.equal(store.counts.stateRows, 2);
    assert.equal(store.agents['nova-id'].agentLabel, 'Nova');
    assert.equal(store.agents['kira-id'].agentLabel, 'Kira');
    assert.equal(store.agents['nova-id'].observationCount, 1);
    assert.equal(store.agents['kira-id'].observationCount, 1);

    const novaStatus = await plugin.processToolCall({ command: 'status', agentId: 'nova-id', agentName: 'Nova' });
    assert.equal(novaStatus.state.agentKey, 'nova-id');
    assert.equal(novaStatus.state.observationCount, 1);

    await plugin.processToolCall({ command: 'reset', agentId: 'kira-id', agentName: 'Kira' });
    store = readAxisStoreFromDb();
    assert.equal(store.agents['nova-id'].observationCount, 1);
    assert.equal(store.agents['kira-id'].observationCount, 0);
    assertAxisStateShape(store.agents['nova-id']);
    assertAxisStateShape(store.agents['kira-id']);
  });
});

await t.test('OpenHerPersona derives stable but distinct seeded defaults per agent key', async () => {
  await withRestoredState(async () => {
    const plugin = freshPlugin();

    await plugin.processToolCall({ command: 'reset', agentId: 'nova-id', agentName: 'Nova' });
    const firstNova = readAgentState('nova-id');

    await plugin.processToolCall({ command: 'reset', agentId: 'kira-id', agentName: 'Kira' });
    const kira = readAgentState('kira-id');

    await plugin.processToolCall({ command: 'reset', agentId: 'nova-id', agentName: 'Nova' });
    const secondNova = readAgentState('nova-id');

    assert(firstNova);
    assert(kira);
    assert(secondNova);
    assert.notDeepEqual(firstNova.baseline.axes, kira.baseline.axes);
    assert.deepEqual(secondNova.baseline.axes, firstNova.baseline.axes);
    assert.equal(secondNova.psyGender, firstNova.psyGender);
  });
});

await t.test('OpenHerPersona persists observer rows in SQLite and reports them through status', async () => {
  await withRestoredState(async () => {
    const plugin = freshPlugin(
      { OpenHerPersonaAsyncObservation: false },
      { embeddingProvider: createEmbeddingProvider() }
    );

    await plugin.processMessages([
      { role: 'system', content: oneRingSystem('Nova') },
      { role: 'user', content: 'SQLite Nova 第一轮。' },
    ]);
    await plugin.processMessages([
      { role: 'system', content: oneRingSystem('Kira') },
      { role: 'user', content: 'SQLite Kira 第一轮。' },
    ]);

    assert(fs.existsSync(stateDbPath), 'SQLite state database should be created');

    const store = readAxisStoreFromDb();
    assert(store);
    assert.equal(store.meta.mode, 'async_observer');
    assert.equal(store.meta.plugin, 'OpenHerPersona');
    assert.equal(store.counts.stateRows, 2);
    assert(store.counts.anchorRows > 0);
    assert(store.counts.auditRows >= 2);
    assert.equal(store.agents.Nova.agentLabel, 'Nova');
    assert.equal(store.agents.Kira.agentLabel, 'Kira');
  });
});

await t.test('OpenHerPersona async queue drains once the message embedding resolves', async () => {
  await withRestoredState(async () => {
    const split = createSplitEmbeddingProvider();
    const plugin = freshPlugin(
      { OpenHerPersonaAsyncObservation: true },
      { embeddingProvider: split.provider }
    );

    const messages = [
      { role: 'system', content: oneRingSystem('Async') },
      { role: 'user', content: '异步队列试一下。' },
    ];
    const processed = await plugin.processMessages(messages, {
      vcpchatExtensions: {
        openHerPersonaAgent: { agentId: 'async-id', agentName: 'Async' },
      },
    });
    assert.strictEqual(processed, messages);

    const queued = await plugin.processToolCall({ command: 'status', agentId: 'async-id', agentName: 'Async' });
    assert.equal(queued.queue.running, true);
    assert.equal(queued.state.observationCount, 0);

    split.releasePendingMessage();
    const finalStatus = await waitFor(async () => {
      const current = await plugin.processToolCall({ command: 'status', agentId: 'async-id', agentName: 'Async' });
      return current.state && current.state.observationCount === 1 && current.queue.running === false ? current : null;
    });

    assert.equal(finalStatus.state.observationCount, 1);
    assert.equal(finalStatus.queue.running, false);
    const store = readAxisStoreFromDb();
    assert(store);
    assert.equal(store.agents['async-id'].observationCount, 1);
  });
});

await t.test('OpenHerPersona skips observation cleanly when embeddings are unavailable', async () => {
  await withRestoredState(async () => {
    const plugin = freshPlugin(
      { OpenHerPersonaAsyncObservation: false },
      { embeddingProvider: createEmbeddingProvider({ nullVectors: true }) }
    );

    const messages = [
      { role: 'system', content: 'base system' },
      { role: 'user', content: 'embedding down' },
    ];
    const processed = await plugin.processMessages(messages, {
      vcpchatExtensions: {
        openHerPersonaAgent: { agentId: 'fail-id', agentName: 'Fail' },
      },
    });
    assert.strictEqual(processed, messages);

    const store = readAxisStoreFromDb();
    assert(store);
    assert.equal(store.counts.stateRows, 1);
    assert.equal(store.counts.anchorRows, 0);
    assert(store.counts.auditRows >= 1);
    assert.equal(store.agents['fail-id'].observationCount, 0);
  });
});

await t.test('OpenHerPersona stays directly after RAGDiaryPlugin and before OneRing', () => {
  const order = JSON.parse(fs.readFileSync(orderPath, 'utf8'));
  const ragIndex = order.indexOf('RAGDiaryPlugin');
  assert(ragIndex >= 0);
  assert.equal(order[ragIndex + 1], 'OpenHerPersona');
  assert.equal(order[ragIndex + 2], 'OneRing');
});
});
