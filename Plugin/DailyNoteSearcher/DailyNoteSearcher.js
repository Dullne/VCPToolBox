const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');

let serviceProcess = null;
let serviceReadyPromise = null;
let serviceConfig = {
    host: '127.0.0.1',
    port: 38765,
    timeout: 60000,
    executablePath: null,
    serviceAvailable: false,
    serviceModeAttempted: false
};

function createTextResult(text) {
    return {
        content: [{
            type: 'text',
            text: String(text ?? '')
        }]
    };
}

function normalizeText(value) {
    return String(value ?? '').trim();
}

function parseAllowedExtensions(value) {
    const source = Array.isArray(value) ? value : String(value || '')
        .split(/[,，、|｜\n\r\t]/);
    const extensions = source
        .map(item => normalizeText(item).replace(/^\./, '').toLowerCase())
        .filter(Boolean);
    return new Set(extensions);
}

function escapeRegExp(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFallbackSearchTerms(args = {}) {
    const queries = Array.isArray(args.queries)
        ? args.queries.map(term => normalizeText(term)).filter(Boolean)
        : [];
    if (queries.length > 0) {
        return queries;
    }

    const query = normalizeText(args.query);
    if (!query) {
        return [];
    }

    return query
        .toLowerCase()
        .split(/\s+/)
        .map(term => term.trim())
        .filter(Boolean);
}

function getProjectRoot() {
    return path.resolve(__dirname, '..', '..');
}

function resolveRootPath(args = {}) {
    const projectRoot = getProjectRoot();
    const rootCandidate = normalizeText(args.root_path || 'dailynote') || 'dailynote';
    return path.isAbsolute(rootCandidate)
        ? path.normalize(rootCandidate)
        : path.resolve(projectRoot, rootCandidate);
}

function resolveSearchRoot(args = {}) {
    const rootPath = resolveRootPath(args);
    const folder = normalizeText(args.folder);
    if (!folder) {
        return rootPath;
    }

    if (folder.includes('..') || folder.includes('/') || folder.includes('\\')) {
        throw new Error('Path traversal detected in folder parameter');
    }

    const candidate = path.resolve(rootPath, folder);
    if (candidate !== rootPath && !candidate.startsWith(rootPath + path.sep)) {
        throw new Error('Path traversal detected in folder parameter');
    }

    return candidate;
}

function buildFallbackOutput(results, total, limited) {
    const content = results.length === 0
        ? `未找到匹配内容。总结果数：${total}。`
        : results
            .map((note, index) => {
                const title = note.folderName ? `[${note.folderName}] ${note.name}` : note.name;
                return `${index + 1}. ${title}\n${note.preview}`;
            })
            .join('\n\n---\n\n') + (limited ? `\n\n(仅显示前 ${results.length} 条，共 ${total} 条)` : '');

    return {
        status: 'success',
        result: {
            notes: results,
            total,
            limited,
            content
        },
        notes: null,
        total,
        limited,
        content: null,
        error: null
    };
}

async function collectSearchFiles(dir, allowedExtensions, maxFileSize = 1024 * 1024, visited = new Set(), files = []) {
    let realPath;
    try {
        realPath = await fs.realpath(dir);
    } catch (_) {
        realPath = path.resolve(dir);
    }

    if (visited.has(realPath)) {
        return files;
    }
    visited.add(realPath);

    let entries = [];
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (_) {
        return files;
    }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            await collectSearchFiles(fullPath, allowedExtensions, maxFileSize, visited, files);
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase();
        if (allowedExtensions.size > 0 && !allowedExtensions.has(ext)) {
            continue;
        }

        try {
            const stat = await fs.stat(fullPath);
            if (stat.size > maxFileSize) {
                continue;
            }
            files.push({
                path: fullPath,
                name: entry.name,
                folderName: path.basename(dir),
                lastModified: stat.mtime.toISOString()
            });
        } catch (_) {
            // Skip unreadable files.
        }
    }

    return files;
}

async function runJsFallbackSearch(args = {}) {
    const query = normalizeText(args.query);
    const queryTokens = buildFallbackSearchTerms(args);
    const isRegex = Boolean(args.is_regex ?? args.isRegex);
    const caseSensitive = Boolean(args.case_sensitive ?? args.caseSensitive);
    const wholeWord = Boolean(args.whole_word ?? args.wholeWord);
    const maxResults = Math.max(1, Number(args.max_results || args.bm25_limit || 200) || 200);
    const allowedExtensions = parseAllowedExtensions(args.allowed_extensions || 'md,txt,json,html');
    const searchRoot = resolveSearchRoot(args);
    const fileMetas = await collectSearchFiles(searchRoot, allowedExtensions);

    let matcher = null;
    if (isRegex && query) {
        const flags = caseSensitive ? 'u' : 'iu';
        try {
            matcher = new RegExp(query, flags);
        } catch (error) {
            return {
                status: 'error',
                result: null,
                notes: null,
                total: 0,
                limited: false,
                content: null,
                error: `Invalid regular expression: ${error.message}`
            };
        }
    }

    const matchedFiles = [];
    for (const file of fileMetas) {
        try {
            const content = await fs.readFile(file.path, 'utf8');
            let matched = false;
            if (matcher) {
                matcher.lastIndex = 0;
                matched = matcher.test(content);
            } else if (queryTokens.length > 0) {
                const haystack = caseSensitive ? content : content.toLowerCase();
                matched = queryTokens.every((term) => {
                    const needle = caseSensitive ? term : term.toLowerCase();
                    if (!wholeWord) {
                        return haystack.includes(needle);
                    }
                    const wholeWordPattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(needle)}([^\\p{L}\\p{N}_]|$)`, caseSensitive ? 'u' : 'iu');
                    return wholeWordPattern.test(content);
                });
            }

            if (matched) {
                matchedFiles.push({
                    ...file,
                    preview: content.substring(0, 100).replace(/\n/g, ' ') + (content.length > 100 ? '...' : '')
                });
            }
        } catch (_) {
            // Skip unreadable files.
        }
    }

    matchedFiles.sort((a, b) => String(b.lastModified).localeCompare(String(a.lastModified)));
    const total = matchedFiles.length;
    const limited = total > maxResults;
    const notes = matchedFiles.slice(0, maxResults);

    return buildFallbackOutput(notes, total, limited);
}

function getExecutableCandidates() {
    const pluginDir = __dirname;
    if (process.platform === 'win32') {
        return [
            path.join(pluginDir, 'DailyNoteSearcher.exe'),
            path.join(pluginDir, 'src', 'target', 'release', 'DailyNoteSearcher.exe'),
            path.join(pluginDir, 'src', 'target', 'debug', 'DailyNoteSearcher.exe')
        ];
    }

    if (process.platform === 'linux') {
        return [
            path.join(pluginDir, 'DailyNoteSearcher'),
            path.join(pluginDir, 'DailyNoteSearcher-aarch64-unknown-linux-musl'),
            path.join(pluginDir, 'src', 'target', 'release', 'DailyNoteSearcher'),
            path.join(pluginDir, 'src', 'target', 'debug', 'DailyNoteSearcher')
        ];
    }

    return [
        path.join(pluginDir, 'DailyNoteSearcher'),
        path.join(pluginDir, 'src', 'target', 'release', 'DailyNoteSearcher'),
        path.join(pluginDir, 'src', 'target', 'debug', 'DailyNoteSearcher')
    ];
}

async function findExecutable() {
    const fs = require('fs').promises;
    for (const candidate of getExecutableCandidates()) {
        try {
            await fs.access(candidate);
            return candidate;
        } catch (_) {
            // continue
        }
    }
    throw new Error(`DailyNoteSearcher executable not found. Tried: ${getExecutableCandidates().join(', ')}`);
}

function postJson(payload, timeoutMs = serviceConfig.timeout) {
    const body = JSON.stringify(payload || {});
    const requestOptions = {
        hostname: serviceConfig.host,
        port: serviceConfig.port,
        path: '/search',
        method: 'POST',
        timeout: timeoutMs,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
        }
    };

    return new Promise((resolve, reject) => {
        const req = http.request(requestOptions, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {
                data += chunk;
                if (data.length > 128 * 1024 * 1024) {
                    req.destroy(new Error('DailyNoteSearcher HTTP response exceeded 128MB'));
                }
            });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data || '{}');
                    resolve(parsed);
                } catch (error) {
                    reject(new Error(`DailyNoteSearcher returned invalid JSON: ${error.message}; body=${data.slice(0, 300)}`));
                }
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error(`DailyNoteSearcher HTTP request timed out after ${timeoutMs}ms`));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function runOneShotExecutable(args, timeoutMs = serviceConfig.timeout) {
    let executablePath;
    try {
        executablePath = serviceConfig.executablePath || await findExecutable();
        serviceConfig.executablePath = executablePath;
    } catch (error) {
        return runJsFallbackSearch(args);
    }

    try {
        return await new Promise((resolve, reject) => {
            const child = spawn(executablePath, [], {
                cwd: path.resolve(__dirname, '..', '..'),
                env: process.env,
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                child.kill();
                reject(new Error(`DailyNoteSearcher one-shot request timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            child.stdout.on('data', chunk => {
                stdout += chunk.toString('utf8');
            });
            child.stderr.on('data', chunk => {
                stderr += chunk.toString('utf8');
            });
            child.on('error', error => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            });
            child.on('exit', code => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (code !== 0) {
                    reject(new Error(`DailyNoteSearcher one-shot exited with code ${code}: ${stderr.trim()}`));
                    return;
                }
                try {
                    resolve(JSON.parse(stdout || '{}'));
                } catch (error) {
                    reject(new Error(`DailyNoteSearcher one-shot returned invalid JSON: ${error.message}; stdout=${stdout.slice(0, 300)}; stderr=${stderr.slice(0, 300)}`));
                }
            });

            child.stdin.end(JSON.stringify(args || {}));
        });
    } catch (error) {
        if (error && (error.code === 'ENOEXEC' || /ENOEXEC/.test(error.message || ''))) {
            console.warn('[DailyNoteSearcher Service] Executable is incompatible on this platform; using JS fallback search.');
            return runJsFallbackSearch(args);
        }
        throw error;
    }
}

async function waitForServiceReady(deadlineMs = 8000) {
    const startedAt = Date.now();
    let lastError = null;

    while (Date.now() - startedAt < deadlineMs) {
        try {
            const result = await postJson({
                query: '__daily_note_searcher_healthcheck__',
                root_path: '.',
                allowed_extensions: 'unlikely_ext',
                max_results: 1
            }, 1000);
            if (result && (result.status === 'success' || result.status === 'error')) {
                return true;
            }
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 150));
    }

    throw new Error(`DailyNoteSearcher HTTP service did not become ready: ${lastError?.message || 'timeout'}`);
}

async function ensureServiceStarted() {
    if (serviceProcess && !serviceProcess.killed) {
        return;
    }
    if (serviceConfig.serviceModeAttempted && !serviceConfig.serviceAvailable) {
        return;
    }
    if (serviceReadyPromise) {
        return serviceReadyPromise;
    }

    serviceReadyPromise = (async () => {
        serviceConfig.executablePath = serviceConfig.executablePath || await findExecutable();
        serviceConfig.serviceModeAttempted = true;

        const env = {
            ...process.env,
            DAILY_NOTE_SEARCHER_HOST: serviceConfig.host,
            DAILY_NOTE_SEARCHER_PORT: String(serviceConfig.port)
        };

        serviceProcess = spawn(serviceConfig.executablePath, ['--serve'], {
            cwd: path.resolve(__dirname, '..', '..'),
            env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        serviceProcess.stdout.on('data', chunk => {
            if (serviceConfig.debug) {
                console.log(`[DailyNoteSearcher Service stdout] ${chunk.toString('utf8').trim()}`);
            }
        });

        serviceProcess.stderr.on('data', chunk => {
            const text = chunk.toString('utf8').trim();
            if (text) console.log(`[DailyNoteSearcher Service] ${text}`);
        });

        serviceProcess.on('exit', (code, signal) => {
            console.warn(`[DailyNoteSearcher Service] exited with code=${code}, signal=${signal}`);
            const wasAvailable = serviceConfig.serviceAvailable;
            serviceProcess = null;
            serviceReadyPromise = null;
            serviceConfig.serviceAvailable = false;
            if (wasAvailable) {
                serviceConfig.serviceModeAttempted = false;
            }
        });

        serviceProcess.on('error', error => {
            console.error('[DailyNoteSearcher Service] failed to start:', error.message);
            serviceProcess = null;
            serviceReadyPromise = null;
            serviceConfig.serviceAvailable = false;
            serviceConfig.serviceModeAttempted = false;
        });

        await waitForServiceReady();
        serviceConfig.serviceAvailable = true;
    })();

    try {
        await serviceReadyPromise;
    } catch (error) {
        if (serviceProcess && !serviceProcess.killed) {
            serviceProcess.kill();
        }
        serviceProcess = null;
        serviceReadyPromise = null;
        serviceConfig.serviceAvailable = false;
        console.warn(`[DailyNoteSearcher Service] Falling back to one-shot executable mode: ${error.message}`);
    }
}

async function initialize(config = {}) {
    serviceConfig.host = String(config.DAILY_NOTE_SEARCHER_HOST || process.env.DAILY_NOTE_SEARCHER_HOST || '127.0.0.1');
    serviceConfig.port = parseInt(config.DAILY_NOTE_SEARCHER_PORT || process.env.DAILY_NOTE_SEARCHER_PORT || '38765', 10) || 38765;
    serviceConfig.timeout = parseInt(config.DAILY_NOTE_SEARCHER_TIMEOUT || process.env.DAILY_NOTE_SEARCHER_TIMEOUT || '60000', 10) || 60000;
    serviceConfig.debug = String(config.DebugMode || process.env.DebugMode || 'false').toLowerCase() === 'true';

    await ensureServiceStarted();
    if (serviceConfig.serviceAvailable) {
        console.log(`[DailyNoteSearcher Service] Initialized on http://${serviceConfig.host}:${serviceConfig.port}`);
    } else {
        console.warn('[DailyNoteSearcher Service] Initialized in one-shot executable fallback mode.');
    }
}

async function processToolCall(args) {
    await ensureServiceStarted();
    if (!serviceConfig.serviceAvailable || !serviceProcess || serviceProcess.killed) {
        return runOneShotExecutable(args);
    }
    const result = await postJson(args || {});
    return result;
}

async function shutdown() {
    if (serviceProcess && !serviceProcess.killed) {
        serviceProcess.kill();
    }
    serviceProcess = null;
    serviceReadyPromise = null;
    console.log('[DailyNoteSearcher Service] Shutdown complete.');
}

function getServiceEndpoint() {
    return `http://${serviceConfig.host}:${serviceConfig.port}/search`;
}

module.exports = {
    initialize,
    processToolCall,
    shutdown,
    getServiceEndpoint,
    ensureServiceStarted,
    postJson
};
