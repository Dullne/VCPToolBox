const express = require('express');
const dayjs = require('dayjs');
const timezone = require('dayjs/plugin/timezone');
const utc = require('dayjs/plugin/utc');

dayjs.extend(utc);
dayjs.extend(timezone);

function normalizeText(value) {
    return String(value ?? '').trim();
}

function parseBoolean(value, fallback) {
    if (typeof value === 'boolean') return value;
    const text = normalizeText(value).toLowerCase();
    if (!text) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(text)) return true;
    if (['0', 'false', 'no', 'off'].includes(text)) return false;
    return fallback;
}

function splitList(value) {
    if (Array.isArray(value)) {
        return value.map(item => normalizeText(item)).filter(Boolean);
    }
    return normalizeText(value).split(/[,，]/).map(item => normalizeText(item)).filter(Boolean);
}

function sanitizeTag(value) {
    return normalizeText(value)
        .replace(/[,\n\r]+/g, ' ')
        .replace(/\s+/g, '_')
        .replace(/[^\w\u4e00-\u9fff-]/g, '')
        .slice(0, 48);
}

function buildTags(payload) {
    const notebookId = normalizeText(payload.notebook_id ?? payload.notebookId);
    const tags = [
        'groupchat',
        'memory_candidate',
        payload.scope === 'private' ? 'private' : 'shared',
        payload.candidate_id ? `candidate_${sanitizeTag(payload.candidate_id)}` : '',
        payload.session_id ? `session_${sanitizeTag(payload.session_id)}` : '',
        payload.target_role_name ? `role_${sanitizeTag(payload.target_role_name)}` : '',
        notebookId ? `notebook_id_${sanitizeTag(notebookId)}` : ''
    ].filter(Boolean);

    return [...new Set(tags)].join(', ');
}

function resolveNotebook(payload) {
    const scope = normalizeText(payload.scope).toLowerCase();
    if (scope === 'private') {
        return normalizeText(payload.target_role_name || payload.target_role_id || payload.notebook) || '角色私有';
    }
    return normalizeText(payload.notebook) || '公共';
}

/**
 * 解析日记本落盘目录（VCPToolBox 命名空间键）。
 * 优先用上游传入的 notebook_id（person_id 派生），缺失时回退到显示名逻辑以兼容旧调用方。
 */
function resolveNotebookFolder(payload) {
    const explicitNotebookId = normalizeText(payload.notebook_id ?? payload.notebookId);
    if (explicitNotebookId) {
        return explicitNotebookId;
    }
    return resolveNotebook(payload);
}

function buildContent(payload, confirmedBy, isoTime) {
    const lines = [
        '# 群聊确认记忆',
        '',
        '来源: GroupChatBackend',
        `候选ID: ${payload.candidate_id || 'unknown'}`,
        `会话ID: ${payload.session_id || 'unknown'}`,
        payload.reflection_id ? `反思ID: ${payload.reflection_id}` : '',
        `范围: ${payload.scope || 'shared'}`,
        payload.target_role_name || payload.target_role_id
            ? `目标角色: ${payload.target_role_name || payload.target_role_id}`
            : '',
        `确认人: ${confirmedBy || 'unknown'}`,
        `确认时间: ${isoTime}`,
        '',
        '## 内容',
        payload.content,
        '',
        payload.reason ? `## 写入理由\n${payload.reason}\n` : '',
        `Tag: ${buildTags(payload)}`
    ].filter(line => line !== '');

    return lines.join('\n');
}

function parseDailyNotePath(pluginResult) {
    const match = String(pluginResult?.message || '').match(/Diary saved to (.*)$/);
    return match?.[1] || '';
}

function getIndexStatus(knowledgeBaseManager, filePath) {
    if (!filePath || !knowledgeBaseManager || typeof knowledgeBaseManager.getFileIndexStatus !== 'function') {
        return { index_status: 'unavailable', indexed: false };
    }
    try {
        return knowledgeBaseManager.getFileIndexStatus(filePath);
    } catch (error) {
        return {
            index_status: 'status_failed',
            indexed: false,
            error: error.message
        };
    }
}

function buildBatchScanOptions(source = {}) {
    return {
        notebook: normalizeText(source.notebook || source.diary),
        statuses: splitList(source.statuses || source.status),
        limit: source.limit,
        max_scan: source.max_scan || source.maxScan,
        include_indexed: parseBoolean(source.include_indexed ?? source.includeIndexed, false)
    };
}

function sendBatchScanUnavailable(res, knowledgeBaseManager) {
    if (!knowledgeBaseManager || typeof knowledgeBaseManager.listIndexRequeueCandidates !== 'function') {
        res.status(503).json({ error: 'knowledge base candidate scanner unavailable' });
        return true;
    }
    return false;
}

module.exports = function createCoreMemoryRoutes(options = {}) {
    const router = express.Router();
    const { pluginManager, knowledgeBaseManager, defaultTimezone = 'Asia/Shanghai' } = options;

    router.get('/memory-candidates/index-status', (req, res) => {
        const filePath = normalizeText(req.query?.file_path || req.query?.filePath || req.query?.rel_path || req.query?.relPath);
        if (!filePath) {
            return res.status(400).json({ error: 'file_path is required' });
        }
        res.json(getIndexStatus(knowledgeBaseManager, filePath));
    });

    router.get('/memory-candidates/index-requeue-candidates', (req, res) => {
        if (sendBatchScanUnavailable(res, knowledgeBaseManager)) return;

        const scan = knowledgeBaseManager.listIndexRequeueCandidates(buildBatchScanOptions(req.query || {}));
        if (!scan.ok) {
            const status = scan.index_status === 'invalid_scan_root' ? 400 : 503;
            return res.status(status).json(scan);
        }
        res.json({
            ok: true,
            dry_run: true,
            ...scan
        });
    });

    router.post('/memory-candidates/index-requeue', (req, res) => {
        const filePath = normalizeText(req.body?.file_path || req.body?.filePath || req.body?.rel_path || req.body?.relPath);
        if (!filePath) {
            return res.status(400).json({ error: 'file_path is required' });
        }
        if (!knowledgeBaseManager || typeof knowledgeBaseManager.queueFileForIndex !== 'function') {
            return res.status(503).json({ error: 'knowledge base indexer unavailable' });
        }

        let indexResult;
        try {
            indexResult = knowledgeBaseManager.queueFileForIndex(filePath, { flush: 'immediate' });
        } catch (error) {
            return res.status(500).json({
                error: error.message,
                index_status: 'queue_failed'
            });
        }

        res.json({
            ok: indexResult.queued !== false,
            index_status: indexResult.index_status,
            index_result: indexResult,
            index_check: getIndexStatus(knowledgeBaseManager, filePath)
        });
    });

    router.post('/memory-candidates/index-requeue-batch', (req, res) => {
        if (sendBatchScanUnavailable(res, knowledgeBaseManager)) return;
        if (!knowledgeBaseManager || typeof knowledgeBaseManager.queueFileForIndex !== 'function') {
            return res.status(503).json({ error: 'knowledge base indexer unavailable' });
        }

        const payload = req.body || {};
        const dryRun = parseBoolean(payload.dry_run ?? payload.dryRun, true);
        const scan = knowledgeBaseManager.listIndexRequeueCandidates(buildBatchScanOptions(payload));
        if (!scan.ok) {
            const status = scan.index_status === 'invalid_scan_root' ? 400 : 503;
            return res.status(status).json(scan);
        }

        const queueResults = [];
        if (!dryRun) {
            for (let index = 0; index < scan.items.length; index++) {
                const item = scan.items[index];
                try {
                    queueResults.push({
                        rel_path: item.rel_path,
                        file_path: item.file_path,
                        before_index_status: item.index_status,
                        result: knowledgeBaseManager.queueFileForIndex(item.file_path, {
                            flush: index === scan.items.length - 1 ? 'immediate' : undefined
                        })
                    });
                } catch (error) {
                    queueResults.push({
                        rel_path: item.rel_path,
                        file_path: item.file_path,
                        before_index_status: item.index_status,
                        result: {
                            queued: false,
                            index_status: 'queue_failed',
                            error: error.message
                        }
                    });
                }
            }
        }

        res.json({
            ok: true,
            dry_run: dryRun,
            queued_count: dryRun ? 0 : queueResults.filter(item => item.result?.queued !== false).length,
            queue_results: queueResults,
            ...scan
        });
    });

    router.post('/memory-candidates/write', async (req, res) => {
        try {
            if (!pluginManager || typeof pluginManager.executePlugin !== 'function') {
                return res.status(503).json({ error: 'core memory writer unavailable' });
            }

            const payload = req.body || {};
            const content = normalizeText(payload.content);
            if (!content) {
                return res.status(400).json({ error: 'content is required' });
            }

            const confirmedBy = normalizeText(payload.confirmed_by || payload.confirmedBy);
            const isoTime = new Date().toISOString();
            const dateString = dayjs(isoTime).tz(defaultTimezone).format('YYYY-MM-DD');
            const notebook = resolveNotebook(payload);
            const notebookFolder = resolveNotebookFolder(payload);
            const fileName = normalizeText(
                payload.candidate_id || payload.reflection_id || payload.session_id || 'groupchat-memory'
            );
            const contentText = buildContent({ ...payload, content }, confirmedBy, isoTime);

            const pluginResult = await pluginManager.executePlugin('DailyNoteWrite', JSON.stringify({
                maidName: notebook,
                folder: notebookFolder,
                dateString,
                contentText,
                fileName
            }));

            if (!pluginResult || pluginResult.status !== 'success') {
                return res.status(502).json({
                    error: 'DailyNoteWrite failed',
                    plugin_result: pluginResult || null
                });
            }

            const filePath = parseDailyNotePath(pluginResult);
            let indexResult = { queued: false, index_status: 'unavailable' };
            if (filePath && knowledgeBaseManager && typeof knowledgeBaseManager.queueFileForIndex === 'function') {
                try {
                    indexResult = knowledgeBaseManager.queueFileForIndex(filePath);
                } catch (indexError) {
                    indexResult = {
                        queued: false,
                        index_status: 'queue_failed',
                        error: indexError.message
                    };
                }
            }
            const indexCheck = getIndexStatus(knowledgeBaseManager, filePath);

            res.status(201).json({
                ok: true,
                core_write_status: 'written',
                storage_owner: 'VCPToolBox',
                adapter: 'DailyNoteWrite',
                notebook,
                notebook_id: notebookFolder,
                date_string: dateString,
                file_path: filePath,
                index_status: indexResult.index_status,
                index_result: indexResult,
                index_check: indexCheck,
                plugin_result: pluginResult
            });
        } catch (error) {
            res.status(error.status || 500).json({
                error: error.message,
                details: error.payload || null
            });
        }
    });

    return router;
};
