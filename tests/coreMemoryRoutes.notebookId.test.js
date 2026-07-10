const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const coreMemoryRoutesPath = path.join(projectRoot, 'routes', 'coreMemoryRoutes.js');

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('resolveNotebookFolder prefers notebook_id over display-name notebook', () => {
  const source = readSource(coreMemoryRoutesPath);
  // 优先 notebook_id，缺失回退 resolveNotebook（显示名）
  assert.match(source, /function resolveNotebookFolder\(payload\)/);
  assert.match(source, /payload\.notebook_id\s*\?\?\s*payload\.notebookId/);
  assert.match(source, /return resolveNotebook\(payload\)/);
});

test('DailyNoteWrite payload carries folder = notebookFolder so writes land in person-scoped dir', () => {
  const source = readSource(coreMemoryRoutesPath);
  // maidName 仍是显示名（内容署名），folder 是命名空间键
  assert.match(source, /const notebookFolder = resolveNotebookFolder\(payload\)/);
  assert.match(source, /maidName:\s*notebook/);
  assert.match(source, /folder:\s*notebookFolder/);
});

test('buildTags emits notebook_id tag for retrieval-side filtering', () => {
  const source = readSource(coreMemoryRoutesPath);
  assert.match(source, /notebook_id_\$\{sanitizeTag\(notebookId\)\}/);
});

test('write response echoes notebook_id for caller traceability', () => {
  const source = readSource(coreMemoryRoutesPath);
  assert.match(source, /notebook_id:\s*notebookFolder/);
});
