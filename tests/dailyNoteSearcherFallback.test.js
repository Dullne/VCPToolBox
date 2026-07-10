const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('DailyNoteSearcher falls back to one-shot executable when service mode is unavailable', async () => {
    const dailyNoteSearcher = require('../Plugin/DailyNoteSearcher/DailyNoteSearcher');
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-note-searcher-'));
    await fs.writeFile(path.join(tempRoot, 'note.md'), 'alpha fallback needle\n', 'utf8');

    await dailyNoteSearcher.initialize({
        DAILY_NOTE_SEARCHER_PORT: '38997',
        DAILY_NOTE_SEARCHER_TIMEOUT: '3000'
    });

    try {
        const result = await dailyNoteSearcher.processToolCall({
            query: 'fallback needle',
            root_path: tempRoot,
            allowed_extensions: 'md',
            max_results: 5
        });

        assert.equal(result.status, 'success');
        assert.equal(result.total, 1);
        assert.match(JSON.stringify(result), /fallback needle/);
    } finally {
        await dailyNoteSearcher.shutdown();
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
});
