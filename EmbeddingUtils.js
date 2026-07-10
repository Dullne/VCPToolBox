// EmbeddingUtils.js
const { get_encoding } = require("@dqbd/tiktoken");
const encoding = get_encoding("cl100k_base");

// 配置
const embeddingMaxToken = parseInt(process.env.WhitelistEmbeddingModelMaxToken, 10) || 8000;
const safeMaxTokens = Math.floor(embeddingMaxToken * 0.85);
const MAX_BATCH_ITEMS = 100; // Gemini/OpenAI 限制
const DEFAULT_CONCURRENCY = parseInt(process.env.TAG_VECTORIZE_CONCURRENCY) || 5; // 🌟 读取并发配置

function _normalizeBaseUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function _resolveEmbeddingRequestUrl(apiUrl) {
    const normalized = _normalizeBaseUrl(apiUrl);
    return normalized.endsWith('/v1')
        ? `${normalized}/embeddings`
        : `${normalized}/v1/embeddings`;
}

function _normalizeEndpointCandidate(source = {}) {
    const apiUrl = _normalizeBaseUrl(source.apiUrl || source.embeddingApiUrl || source.url);
    const apiKey = String(source.apiKey || source.embeddingApiKey || source.key || '').trim();
    if (!apiUrl || !apiKey) {
        return null;
    }

    return {
        label: String(source.label || source.name || apiUrl).trim(),
        apiUrl,
        apiKey,
        model: String(source.model || source.embeddingModel || '').trim(),
        modelBackups: source.modelBackups,
        encodingFormat: String(source.encodingFormat || source.encoding_format || '').trim()
    };
}

function _resolveEmbeddingEndpoint(config = {}) {
    return _normalizeEndpointCandidate({
        label: 'primary',
        apiUrl: config.embeddingApiUrl || process.env.EMBEDDING_API_URL || config.apiUrl || process.env.API_URL,
        apiKey: config.embeddingApiKey
            || process.env.EMBEDDING_API_Key
            || process.env.EMBEDDING_API_KEY
            || config.apiKey
            || process.env.API_Key
            || '',
        model: config.model || process.env.WhitelistEmbeddingModel,
        modelBackups: config.modelBackups,
        encodingFormat: config.encodingFormat || process.env.EMBEDDING_ENCODING_FORMAT
    });
}

function _readEndpointBackupsFromEnv() {
    const backups = [];

    const addBackup = (source) => {
        const normalized = _normalizeEndpointCandidate(source);
        if (normalized) {
            backups.push(normalized);
        }
    };

    addBackup({
        label: process.env.EMBEDDING_FALLBACK_LABEL || 'fallback',
        apiUrl: process.env.EMBEDDING_FALLBACK_API_URL,
        apiKey: process.env.EMBEDDING_FALLBACK_API_Key || process.env.EMBEDDING_FALLBACK_API_KEY,
        model: process.env.EMBEDDING_FALLBACK_MODEL,
        modelBackups: process.env.EMBEDDING_FALLBACK_MODEL_BACKUPS,
        encodingFormat: process.env.EMBEDDING_FALLBACK_ENCODING_FORMAT
    });

    for (let i = 1; i <= 9; i++) {
        addBackup({
            label: process.env[`EMBEDDING_FALLBACK${i}_LABEL`] || `fallback${i}`,
            apiUrl: process.env[`EMBEDDING_FALLBACK${i}_API_URL`],
            apiKey: process.env[`EMBEDDING_FALLBACK${i}_API_Key`] || process.env[`EMBEDDING_FALLBACK${i}_API_KEY`],
            model: process.env[`EMBEDDING_FALLBACK${i}_MODEL`],
            modelBackups: process.env[`EMBEDDING_FALLBACK${i}_MODEL_BACKUPS`],
            encodingFormat: process.env[`EMBEDDING_FALLBACK${i}_ENCODING_FORMAT`]
        });
    }

    return backups;
}

function _getEmbeddingEndpointCandidates(config = {}) {
    const candidates = [];
    const seen = new Set();
    const addEndpoint = (endpoint) => {
        const normalized = _normalizeEndpointCandidate(endpoint || {});
        if (!normalized) return;
        const dedupeKey = [
            normalized.apiUrl,
            normalized.apiKey,
            normalized.model,
            normalized.encodingFormat
        ].join('\u0000');
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        candidates.push(normalized);
    };

    addEndpoint(_resolveEmbeddingEndpoint(config));

    const configuredBackups = config.endpointBackups || config.embeddingEndpointBackups || [];
    if (Array.isArray(configuredBackups)) {
        configuredBackups.forEach(addEndpoint);
    } else if (configuredBackups && typeof configuredBackups === 'object') {
        addEndpoint(configuredBackups);
    }

    _readEndpointBackupsFromEnv().forEach(addEndpoint);

    return candidates;
}

function _splitModelList(value) {
    return String(value || '')
        .split(/[,，]/)
        .map(model => model.trim())
        .filter(Boolean);
}

function _getEmbeddingModelCandidates(config = {}, endpoint = {}) {
    const candidates = [];

    const addModel = (model) => {
        const normalized = String(model || '').trim();
        if (normalized && !candidates.includes(normalized)) {
            candidates.push(normalized);
        }
    };

    addModel(endpoint.model || config.model || process.env.WhitelistEmbeddingModel);

    if (Array.isArray(endpoint.modelBackups)) {
        endpoint.modelBackups.forEach(addModel);
    } else if (endpoint.modelBackups) {
        _splitModelList(endpoint.modelBackups).forEach(addModel);
    }

    if (Array.isArray(config.modelBackups)) {
        config.modelBackups.forEach(addModel);
    } else if (config.modelBackups) {
        _splitModelList(config.modelBackups).forEach(addModel);
    }

    _splitModelList(process.env.EmbeddingModelBackups).forEach(addModel);

    for (let i = 1; i <= 9; i++) {
        addModel(process.env[`EmbeddingModelBackup${i}`]);
    }

    // 兼容用户误把多个备援写进单个变量的情况。
    _splitModelList(process.env.EmbeddingModelBackup).forEach(addModel);

    return candidates.length > 0 ? candidates : ['google/gemini-embedding-001'];
}

/**
 * 内部函数：发送单个批次
 */
async function _sendBatch(batchTexts, config, batchNumber) {
    const fetch = config.fetchImpl || (await import('node-fetch')).default;
    const endpointCandidates = _getEmbeddingEndpointCandidates(config);
    const endpointAttempts = endpointCandidates
        .map(endpoint => ({ endpoint, models: _getEmbeddingModelCandidates(config, endpoint) }))
        .filter(attempt => attempt.models.length > 0);
    const totalAttempts = endpointAttempts.reduce((total, attempt) => total + attempt.models.length, 0);
    const baseDelay = Number.isFinite(Number(config.retryDelayMs))
        ? Math.max(0, Number(config.retryDelayMs))
        : 1000;
    let attempt = 0;

    if (totalAttempts === 0) {
        throw new Error('Embedding API credentials not configured');
    }

    for (const endpointAttempt of endpointAttempts) {
        const { endpoint, models } = endpointAttempt;
        for (const model of models) {
            attempt++;
            try {
                if (!endpoint.apiUrl || !endpoint.apiKey) {
                    throw new Error('Embedding API credentials not configured');
                }

                const requestUrl = _resolveEmbeddingRequestUrl(endpoint.apiUrl);
                const requestBody = { model, input: batchTexts };
                const encodingFormat = endpoint.encodingFormat || config.encodingFormat || process.env.EMBEDDING_ENCODING_FORMAT;
                if (encodingFormat) {
                    requestBody.encoding_format = encodingFormat;
                }
                const requestHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${endpoint.apiKey}` };

                const response = await fetch(requestUrl, {
                    method: 'POST',
                    headers: requestHeaders,
                    body: JSON.stringify(requestBody)
                });

                const responseBodyText = await response.text();

                if (!response.ok) {
                    if (response.status === 429) {
                        const waitTime = Math.min(5000 * attempt, 15000);
                        console.warn(`[Embedding] Batch ${batchNumber} endpoint "${endpoint.label}" model "${model}" rate limited (429). Switching fallback in ${waitTime / 1000}s...`);
                        await new Promise(r => setTimeout(r, waitTime));
                        continue;
                    }
                    throw new Error(`API Error ${response.status}: ${responseBodyText.substring(0, 500)}`);
                }

                let data;
                try {
                    data = JSON.parse(responseBodyText);
                } catch (parseError) {
                    console.error(`[Embedding] JSON Parse Error for Batch ${batchNumber}:`);
                    console.error(`Response (first 500 chars): ${responseBodyText.substring(0, 500)}`);
                    throw new Error(`Failed to parse API response as JSON: ${parseError.message}`);
                }

                // 增强的响应结构验证和详细错误信息
                if (!data) {
                    throw new Error(`API returned empty/null response`);
                }

                // 检查是否是错误响应
                if (data.error) {
                    const errorMsg = data.error.message || JSON.stringify(data.error);
                    const errorCode = data.error.code || response.status;
                    console.error(`[Embedding] API Error for Batch ${batchNumber}:`);
                    console.error(`  Error Code: ${errorCode}`);
                    console.error(`  Error Message: ${errorMsg}`);
                    console.error(`  Hint: Check if embedding model "${model}" is available on your API server`);
                    throw new Error(`API Error ${errorCode}: ${errorMsg}`);
                }

                if (!data.data) {
                    console.error(`[Embedding] Missing 'data' field in response for Batch ${batchNumber}`);
                    console.error(`Response keys: ${Object.keys(data).join(', ')}`);
                    console.error(`Response preview: ${JSON.stringify(data).substring(0, 500)}`);
                    throw new Error(`Invalid API response structure: missing 'data' field`);
                }

                if (!Array.isArray(data.data)) {
                    console.error(`[Embedding] 'data' field is not an array for Batch ${batchNumber}`);
                    console.error(`data type: ${typeof data.data}`);
                    console.error(`data value: ${JSON.stringify(data.data).substring(0, 200)}`);
                    throw new Error(`Invalid API response structure: 'data' is not an array`);
                }

                if (data.data.length === 0) {
                    console.warn(`[Embedding] Warning: Batch ${batchNumber} returned empty embeddings array`);
                }

                // 简单的 Log，证明并发正在跑
                // console.log(`[Embedding] ✅ Batch ${batchNumber} completed (${batchTexts.length} items) via ${model}.`);

                return data.data.sort((a, b) => a.index - b.index).map(item => item.embedding);

            } catch (e) {
                console.warn(`[Embedding] Batch ${batchNumber}, Endpoint "${endpoint.label}", Model "${model}" failed (${attempt}/${totalAttempts}): ${e.message}`);
                if (attempt === totalAttempts) throw e;
                if (baseDelay > 0) {
                    await new Promise(r => setTimeout(r, baseDelay * Math.min(attempt, 3)));
                }
            }
        }
    }
}

/**
 * 🚀 终极版：并发批量获取 Embeddings
 * 🛡️ 核心保证：返回数组长度 === 输入 texts 长度，跳过/失败的位置填 null
 */
async function getEmbeddingsBatch(texts, config) {
    if (!texts || texts.length === 0) return [];

    // 1. ⚡️ 第一步：纯 CPU 操作，先把所有文本切分成 Batches
    //    同时记录每个文本在原始数组中的索引，以便后续对齐
    const batches = [];         // 每个元素: { texts: string[], originalIndices: number[] }
    let currentBatchTexts = [];
    let currentBatchIndices = [];
    let currentBatchTokens = 0;
    const oversizeIndices = new Set(); // 记录被跳过的超长文本位置

    for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        const textTokens = encoding.encode(text).length;
        if (textTokens > safeMaxTokens) {
            console.warn(`[Embedding] ⚠️ Text at index ${i} exceeds token limit (${textTokens} > ${safeMaxTokens}), skipping.`);
            oversizeIndices.add(i);
            continue; // Skip oversize，但记录位置
        }

        const isTokenFull = currentBatchTexts.length > 0 && (currentBatchTokens + textTokens > safeMaxTokens);
        const isItemFull = currentBatchTexts.length >= MAX_BATCH_ITEMS;

        if (isTokenFull || isItemFull) {
            batches.push({ texts: currentBatchTexts, originalIndices: currentBatchIndices });
            currentBatchTexts = [text];
            currentBatchIndices = [i];
            currentBatchTokens = textTokens;
        } else {
            currentBatchTexts.push(text);
            currentBatchIndices.push(i);
            currentBatchTokens += textTokens;
        }
    }
    if (currentBatchTexts.length > 0) {
        batches.push({ texts: currentBatchTexts, originalIndices: currentBatchIndices });
    }

    if (oversizeIndices.size > 0) {
        console.warn(`[Embedding] ⚠️ ${oversizeIndices.size} texts skipped due to token limit.`);
    }
    console.log(`[Embedding] Prepared ${batches.length} batches from ${texts.length} texts. Executing with concurrency: ${DEFAULT_CONCURRENCY}...`);

    // 2. 🌊 第二步：并发执行器
    const batchResults = new Array(batches.length); // 预分配结果数组，保证顺序
    let cursor = 0; // 当前处理到的批次索引

    // 定义 Worker：只要队列里还有任务，就不断抢任务做
    const worker = async (workerId) => {
        while (true) {
            // 🔒 获取任务索引 (原子操作模拟)
            const batchIndex = cursor++;
            if (batchIndex >= batches.length) break; // 没任务了，下班

            const batch = batches[batchIndex];
            try {
                // 执行请求 (Batch ID 从 1 开始显示)
                batchResults[batchIndex] = {
                    vectors: await _sendBatch(batch.texts, config, batchIndex + 1),
                    originalIndices: batch.originalIndices
                };
            } catch (e) {
                // 🛡️ 不再让单个 batch 失败导致整个 Promise.all 崩溃
                // 而是记录失败，对应位置将填 null
                console.error(`[Embedding] ❌ Batch ${batchIndex + 1} failed permanently: ${e.message}`);
                batchResults[batchIndex] = {
                    vectors: null, // 标记为失败
                    originalIndices: batch.originalIndices,
                    error: e.message
                };
            }
        }
    };

    // 启动 N 个 Worker
    const workers = [];
    for (let i = 0; i < DEFAULT_CONCURRENCY; i++) {
        workers.push(worker(i));
    }

    // 等待所有 Worker 下班
    await Promise.all(workers);

    // 3. 📦 第三步：按原始索引回填结果，保证 output.length === input.length
    const finalResults = new Array(texts.length).fill(null); // 默认全部为 null
    let successCount = 0;
    let failCount = 0;

    for (const result of batchResults) {
        if (!result || !result.vectors) {
            // 整个 batch 失败，对应位置保持 null
            if (result) failCount += result.originalIndices.length;
            continue;
        }
        result.originalIndices.forEach((origIdx, vecIdx) => {
            finalResults[origIdx] = result.vectors[vecIdx] || null;
            if (result.vectors[vecIdx]) successCount++;
            else failCount++;
        });
    }

    failCount += oversizeIndices.size; // 超长文本也算失败

    if (failCount > 0) {
        console.warn(`[Embedding] ⚠️ Results: ${successCount} succeeded, ${failCount} failed/skipped out of ${texts.length} total.`);
    }

    return finalResults; // 🛡️ 长度严格等于 texts.length，失败位置为 null
}

/**
 * 余弦相似度计算（公共版本）
 * 供 toolExecutor / messageProcessor / 其他模块复用
 */
function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

module.exports = { getEmbeddingsBatch, cosineSimilarity };
