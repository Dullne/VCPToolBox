const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DirectDiaryTextProcessor = require('../Plugin/RAGDiaryPlugin/DirectDiaryTextProcessor');

function createProcessor(rootPath) {
    return new DirectDiaryTextProcessor({
        dailyNoteRootPath: rootPath,
        logger: {
            log() {},
            warn() {},
            error() {}
        }
    });
}

test('missing direct diary placeholders are omitted from model context', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'direct-diary-missing-'));
    const processor = createProcessor(rootPath);

    const processed = await processor.processContent(
        '私有={{小吉日记本}}\n知识={{小吉的知识日记本}}\nBM25={{小娜日记本::BM25}}',
        { sanitizedUserInput: 'hello' }
    );

    assert.equal(processed, '私有=\n知识=\nBM25=');
    assert.doesNotMatch(processed, /无法读取|内容为空/);
});

test('empty direct diary placeholders are omitted from model context', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'direct-diary-empty-'));
    await fs.mkdir(path.join(rootPath, '小吉'));
    const processor = createProcessor(rootPath);

    const processed = await processor.processContent('私有={{小吉日记本}}');

    assert.equal(processed, '私有=');
    assert.doesNotMatch(processed, /无法读取|内容为空/);
});

test('direct diary placeholders still inject existing notebook content', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'direct-diary-existing-'));
    await fs.mkdir(path.join(rootPath, '小吉'));
    await fs.writeFile(path.join(rootPath, '小吉', 'note.txt'), '小吉记得莱恩喜欢先看证据。', 'utf8');
    const processor = createProcessor(rootPath);

    const processed = await processor.processContent('私有={{小吉日记本}}');

    assert.equal(processed, '私有=小吉记得莱恩喜欢先看证据。');
});

test('duplicate direct diary placeholders do not leak circular-reference markers', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'direct-diary-duplicate-'));
    await fs.mkdir(path.join(rootPath, '公共'));
    await fs.writeFile(path.join(rootPath, '公共', 'note.txt'), '公共结论：先看真实链路。', 'utf8');
    const processor = createProcessor(rootPath);

    const processed = await processor.processContent('共享A={{公共日记本}}\n共享B={{公共日记本}}');

    assert.equal(processed, '共享A=公共结论：先看真实链路。\n共享B=');
    assert.doesNotMatch(processed, /循环引用/);
});
