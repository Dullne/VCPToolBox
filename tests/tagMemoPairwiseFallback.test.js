const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const TagMemoEngine = require('../TagMemoEngine');

function vectorBlob(values) {
  const vector = new Float32Array(values);
  return Buffer.from(vector.buffer);
}

function createTagMemoDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagmemo-pairwise-'));
  const dbPath = path.join(tempDir, 'knowledge_base.sqlite');
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY,
      vector BLOB
    );
    CREATE TABLE file_tags (
      file_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL
    );
    CREATE TABLE tag_pair_similarity (
      tag_a INTEGER NOT NULL,
      tag_b INTEGER NOT NULL,
      similarity REAL NOT NULL,
      model_sig TEXT NOT NULL,
      computed_at INTEGER NOT NULL,
      PRIMARY KEY (tag_a, tag_b)
    );
  `);

  const insertTag = db.prepare('INSERT INTO tags (id, vector) VALUES (?, ?)');
  insertTag.run(1, vectorBlob([1, 0]));
  insertTag.run(2, vectorBlob([1, 0]));
  insertTag.run(3, vectorBlob([0, 1]));

  const insertFileTag = db.prepare('INSERT INTO file_tags (file_id, tag_id) VALUES (?, ?)');
  insertFileTag.run(1, 1);
  insertFileTag.run(1, 2);
  insertFileTag.run(1, 3);

  return { db, tempDir };
}

test('TagMemo recomputes pairwise similarities in JS when the native Vexus method is unavailable', async () => {
  const { db, tempDir } = createTagMemoDb();
  try {
    const engine = new TagMemoEngine(
      db,
      {},
      { dimension: 2, modelSig: 'unit-test-model' },
      { KnowledgeBaseManager: {} }
    );

    const result = await engine.recomputePairwiseSimilarities({
      blocking: true,
      minSimilarity: 0.5
    });

    assert.deepEqual(
      {
        pairCount: result.pairCount,
        computedCount: result.computedCount,
        storedCount: result.storedCount
      },
      {
        pairCount: 3,
        computedCount: 3,
        storedCount: 1
      }
    );

    const rows = db.prepare(
      'SELECT tag_a, tag_b, similarity, model_sig FROM tag_pair_similarity ORDER BY tag_a, tag_b'
    ).all();

    assert.equal(rows.length, 1);
    assert.equal(rows[0].tag_a, 1);
    assert.equal(rows[0].tag_b, 2);
    assert.equal(rows[0].model_sig, engine.modelSig);
    assert(Math.abs(rows[0].similarity - 1) < 1e-6);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
