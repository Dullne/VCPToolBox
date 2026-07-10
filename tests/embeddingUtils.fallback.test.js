const assert = require('node:assert/strict');
const test = require('node:test');

const { getEmbeddingsBatch } = require('../EmbeddingUtils');

function jsonResponse(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
            return JSON.stringify(payload);
        }
    };
}

test('embedding batch falls back to backup endpoint with endpoint-specific model and encoding format', async () => {
    const calls = [];
    const backupVector = new Array(1024).fill(0).map((_, index) => index / 1024);

    const fetchImpl = async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push({ url, body });

        if (String(url).startsWith('https://primary.example')) {
            return jsonResponse(500, { error: { message: 'primary down' } });
        }

        return jsonResponse(200, {
            object: 'list',
            data: [
                {
                    object: 'embedding',
                    index: 0,
                    embedding: backupVector
                }
            ]
        });
    };

    const result = await getEmbeddingsBatch(['fallback probe'], {
        apiUrl: 'https://primary.example',
        apiKey: 'primary-key',
        model: 'BAAI/bge-m3',
        retryDelayMs: 0,
        endpointBackups: [
            {
                apiUrl: 'https://api-inference.modelscope.cn/v1',
                apiKey: 'modelscope-key',
                model: 'Qwen/Qwen3-Embedding-0.6B',
                encodingFormat: 'float'
            }
        ],
        fetchImpl
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://primary.example/v1/embeddings');
    assert.equal(calls[0].body.model, 'BAAI/bge-m3');
    assert.equal(calls[0].body.encoding_format, undefined);
    assert.equal(calls[1].url, 'https://api-inference.modelscope.cn/v1/embeddings');
    assert.equal(calls[1].body.model, 'Qwen/Qwen3-Embedding-0.6B');
    assert.equal(calls[1].body.encoding_format, 'float');
    assert.deepEqual(result, [backupVector]);
});
