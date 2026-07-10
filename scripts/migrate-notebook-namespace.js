#!/usr/bin/env node
/**
 * 角色记忆命名空间迁移脚本（Option B 一次性迁移）。
 *
 * 把按"角色显示名"组织的日记文件夹 + KnowledgeBase files.diary_name 迁移到
 * person_id 派生的稳定 notebook_id 命名空间：
 *   private:   {oldName}/        → person-{personId}-private/
 *   knowledge: {oldName}/        → person-{personId}-knowledge/
 *   其余无 person 对应的文件夹    → shared-{name}/
 *
 * 默认 dry-run，仅打印计划；加 --execute 才落盘。
 *
 * 环境变量：
 *   GROUPCHAT_DB_PATH            VCPGroupChat groupchat.db 路径
 *   KNOWLEDGEBASE_ROOT_PATH      VCPToolBox 日记根目录（含文件夹与 knowledge_base.sqlite）
 *
 * 用法：
 *   node scripts/migrate-notebook-namespace.js            # dry-run
 *   node scripts/migrate-notebook-namespace.js --execute    # 落盘
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// better-sqlite3 在两个仓库各有一份：优先 VCPToolBox 自身，回退 VCPGroupChat/apps/backend。
function loadDatabase() {
    const candidates = [
        'better-sqlite3',
        path.resolve(__dirname, '../../VCPGroupChat/apps/backend/node_modules/better-sqlite3'),
        path.resolve(__dirname, '../node_modules/better-sqlite3')
    ];
    for (const candidate of candidates) {
        try {
            return require(candidate);
        } catch (_) {
            // 继续尝试下一个候选路径
        }
    }
    throw new Error('better-sqlite3 not found. Set NODE_PATH or install it in VCPToolBox.');
}
const Database = loadDatabase();

const GROUPCHAT_DB_PATH = process.env.GROUPCHAT_DB_PATH
    || path.resolve(__dirname, '../../VCPGroupChat/apps/backend/data/groupchat.db');
const KB_ROOT_PATH = process.env.KNOWLEDGEBASE_ROOT_PATH
    || path.resolve(__dirname, '../dailynote');
const KB_STORE_PATH = process.env.KNOWLEDGEBASE_STORE_PATH
    || path.resolve(__dirname, '../VectorStore');
const KB_DB_PATH = path.join(KB_STORE_PATH, 'knowledge_base.sqlite');

const SHOULD_EXECUTE = process.argv.includes('--execute');

function normalizeText(value) {
    return String(value ?? '').trim();
}

function safeJsonParse(value, fallback = {}) {
    try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

function sanitizeNotebookSegment(name) {
    return String(name ?? '')
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/[‎‏‪-‮⁦-⁩]/g, '')
        .replace(/[​-‍﻿]/g, '')
        .replace(/\s+/g, '_')
        .replace(/^[._]+|[._]+$/g, '')
        .replace(/_+/g, '_')
        .slice(0, 100);
}

function personNotebookId(personId, type) {
    const id = sanitizeNotebookSegment(personId);
    return id ? `person-${id}-${type}` : '';
}

function sharedNotebookId(name) {
    const seg = sanitizeNotebookSegment(name);
    return seg ? `shared-${seg}` : '';
}

function loadPersons() {
    if (!fs.existsSync(GROUPCHAT_DB_PATH)) {
        throw new Error(`groupchat.db not found: ${GROUPCHAT_DB_PATH} (set GROUPCHAT_DB_PATH)`);
    }
    const db = new Database(GROUPCHAT_DB_PATH, { readonly: true });
    // 阶段4后 legacy_role_id 列已删，改用 runtime_role_id（旧 DB 回退 legacy_role_id）
    let rows;
    try {
        rows = db.prepare(`
            SELECT id, display_name, runtime_role_id, identity_kind, memory_json, created_at
            FROM persons
            ORDER BY created_at ASC, id ASC
        `).all();
    } catch (e) {
        // 旧 DB 没有 runtime_role_id 列，回退 legacy_role_id
        rows = db.prepare(`
            SELECT id, display_name, legacy_role_id, identity_kind, memory_json, created_at
            FROM persons
            ORDER BY created_at ASC, id ASC
        `).all().map(r => ({ ...r, runtime_role_id: r.legacy_role_id }));
    }
    db.close();
    return rows.map(row => {
        const memory = safeJsonParse(row.memory_json, {});
        return {
            id: normalizeText(row.id),
            display_name: normalizeText(row.display_name),
            runtime_role_id: normalizeText(row.runtime_role_id),
            identity_kind: normalizeText(row.identity_kind),
            privateNotebook: normalizeText(memory.privateNotebook || memory.private_notebook || row.display_name),
            knowledgeNotebook: normalizeText(memory.knowledgeNotebook || memory.knowledge_notebook || ''),
            created_at: row.created_at
        };
    });
}

function listDiaryFolders() {
    if (!fs.existsSync(KB_ROOT_PATH)) {
        throw new Error(`knowledge base root not found: ${KB_ROOT_PATH} (set KNOWLEDGEBASE_ROOT_PATH)`);
    }
    return fs.readdirSync(KB_ROOT_PATH, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .filter(name => !name.startsWith('.') && name !== '已整理');
}

function buildPlan() {
    const persons = loadPersons();
    const folders = listDiaryFolders();
    const plan = [];
    const conflicts = [];

    // 优先 real person；同名 legacy_person 让位
    const realPersons = persons.filter(p => p.identity_kind !== 'legacy_person');
    const legacyPersons = persons.filter(p => p.identity_kind === 'legacy_person');

    const claimed = new Set();

    function emitPersonMappings(person) {
        if (!person.id) return;
        const privateOld = person.privateNotebook;
        const knowledgeOld = person.knowledgeNotebook;
        const privateNew = personNotebookId(person.id, 'private');
        const knowledgeNew = personNotebookId(person.id, 'knowledge');

        if (privateOld && folders.includes(privateOld) && !claimed.has(privateOld)) {
            claimed.add(privateOld);
            plan.push({ kind: 'private', person_id: person.id, display_name: person.display_name, old: privateOld, new: privateNew });
        }
        if (knowledgeOld && folders.includes(knowledgeOld) && !claimed.has(knowledgeOld)) {
            claimed.add(knowledgeOld);
            plan.push({ kind: 'knowledge', person_id: person.id, display_name: person.display_name, old: knowledgeOld, new: knowledgeNew });
        }
    }

    for (const person of realPersons) emitPersonMappings(person);

    // legacy_person 仅处理未被 real person 认领的文件夹，并标记为过渡
    for (const person of legacyPersons) {
        const before = claimed.size;
        emitPersonMappings(person);
        // 若 legacy_person 与 real person 共享 legacy_role_id 且 real person 已认领，跳过（已通过 claimed 判定）
        void before;
    }

    // 检测冲突：多个 person 指向同一旧文件夹（在 claimed 逻辑下第二个会被跳过，这里显式报告）
    const oldFolderOwners = new Map();
    for (const person of persons) {
        for (const old of [person.privateNotebook, person.knowledgeNotebook].filter(Boolean)) {
            if (!folders.includes(old)) continue;
            if (!oldFolderOwners.has(old)) oldFolderOwners.set(old, []);
            oldFolderOwners.get(old).push(person);
        }
    }
    for (const [old, owners] of oldFolderOwners) {
        const realOwners = owners.filter(o => o.identity_kind !== 'legacy_person');
        if (realOwners.length > 1) {
            conflicts.push({ old, owners: owners.map(o => `${o.display_name}(${o.id})`) });
        }
    }

    // v2：剩余未被认领的文件夹 → shared-{name} 命名空间。
    // 这些是共享本（如"公共"）或 smoke 测试夹，加 shared- 前缀与 private/knowledge 风格一致。
    for (const folder of folders) {
        if (claimed.has(folder)) continue;
        const newId = sharedNotebookId(folder);
        if (newId && newId !== folder) {
            plan.push({ kind: 'shared', old: folder, new: newId });
        }
    }

    return { plan, conflicts, persons: persons.length, folders };
}

function renameFolder(oldName, newName) {
    const oldPath = path.join(KB_ROOT_PATH, oldName);
    const newPath = path.join(KB_ROOT_PATH, newName);
    if (fs.existsSync(newPath)) {
        return { ok: false, reason: 'target_exists', oldPath, newPath };
    }
    fs.renameSync(oldPath, newPath);
    return { ok: true, oldPath, newPath };
}

function updateKbDiaryName(db, oldName, newName) {
    const stmt = db.prepare('UPDATE files SET diary_name = ? WHERE diary_name = ?');
    const info = stmt.run(newName, oldName);
    return info.changes;
}

function execute(plan) {
    if (!fs.existsSync(KB_DB_PATH)) {
        console.warn(`[warn] knowledge_base.sqlite not found at ${KB_DB_PATH}; skipping files.diary_name update.`);
    }
    const db = fs.existsSync(KB_DB_PATH) ? new Database(KB_DB_PATH) : null;
    let folderRenames = 0;
    let folderSkipped = 0;
    let dbUpdates = 0;
    let promptUpdates = 0;
    const log = [];

    for (const entry of plan) {
        const result = renameFolder(entry.old, entry.new);
        if (result.ok) {
            folderRenames += 1;
            log.push({ event: 'rename_folder', ...entry, ...result });
        } else {
            folderSkipped += 1;
            log.push({ event: 'skip_folder', ...entry, ...result });
            continue;
        }
        if (db) {
            const changes = updateKbDiaryName(db, entry.old, entry.new);
            dbUpdates += changes;
            log.push({ event: 'update_diary_name', ...entry, rows: changes });
        }
        // shared 类型：同步替换 group_profiles.group_prompt/invite_prompt 里的占位符
        if (entry.kind === 'shared') {
            const changes = updateGroupPromptPlaceholders(entry.old, entry.new);
            promptUpdates += changes;
            log.push({ event: 'update_group_prompt', ...entry, rows: changes });
        }
    }

    if (db) db.close();

    // 写回滚日志
    const logPath = path.join(KB_ROOT_PATH, 'migrate_notebook_namespace.log');
    fs.writeFileSync(logPath, JSON.stringify({ executedAt: new Date().toISOString(), log }, null, 2));
    return { folderRenames, folderSkipped, dbUpdates, promptUpdates, logPath };
}

/**
 * 替换 group_profiles.group_prompt/invite_prompt 里的 {{oldName日记本}} → {{newName日记本}}。
 * 返回受影响的行数。
 */
function updateGroupPromptPlaceholders(oldName, newName) {
    // 用独立的 groupchat DB 连接（KB_DB_PATH 是 VCPToolBox 的，groupchat DB 是另一个）
    const Database = require('better-sqlite3');
    let gcDb = null;
    try {
        gcDb = new Database(GROUPCHAT_DB_PATH);
    } catch (e) {
        console.warn(`[migrate] cannot open groupchat.db for prompt update: ${e.message}`);
        return 0;
    }
    const oldPlaceholder = `{{${oldName}日记本}}`;
    const newPlaceholder = `{{${newName}日记本}}`;
    let totalChanges = 0;
    try {
        const stmt = gcDb.prepare(`
            UPDATE group_profiles
            SET group_prompt = REPLACE(group_prompt, ?, ?),
                invite_prompt = REPLACE(invite_prompt, ?, ?)
            WHERE group_prompt LIKE ? OR invite_prompt LIKE ?
        `);
        const info = stmt.run(oldPlaceholder, newPlaceholder, oldPlaceholder, newPlaceholder,
            `%${oldPlaceholder}%`, `%${oldPlaceholder}%`);
        totalChanges = info.changes;
    } catch (e) {
        console.warn(`[migrate] group_prompt update failed: ${e.message}`);
    } finally {
        gcDb.close();
    }
    return totalChanges;
}

function main() {
    console.log(`[migrate-notebook-namespace] mode=${SHOULD_EXECUTE ? 'EXECUTE' : 'DRY-RUN'}`);
    console.log(`  GROUPCHAT_DB_PATH    = ${GROUPCHAT_DB_PATH}`);
    console.log(`  KNOWLEDGEBASE_ROOT   = ${KB_ROOT_PATH}`);
    console.log(`  KB_STORE_PATH        = ${KB_STORE_PATH}`);
    console.log(`  KB_DB_PATH           = ${KB_DB_PATH}`);
    console.log('');

    const { plan, conflicts, persons, folders } = buildPlan();

    console.log(`persons scanned: ${persons}`);
    console.log(`diary folders found: ${folders.length} (${folders.join(', ')})`);
    console.log(`migration entries: ${plan.length}`);
    console.log('');

    if (conflicts.length) {
        console.warn('⚠ 冲突（多个 real person 指向同一旧文件夹，仅最早创建者认领）：');
        for (const c of conflicts) {
            console.warn(`  ${c.old} ← ${c.owners.join(', ')}`);
        }
        console.warn('  请人工裁决后重跑。已为冲突项保留最早创建者的迁移，其余 person 需手动指定。\n');
    }

    for (const entry of plan) {
        const owner = entry.person_id ? ` [${entry.display_name} ${entry.person_id}]` : '';
        console.log(`  ${entry.kind}${owner}: ${entry.old} → ${entry.new}`);
    }
    console.log('');

    if (!SHOULD_EXECUTE) {
        console.log('[dry-run] 未落盘。确认无误后加 --execute 重跑。');
        return;
    }

    const result = execute(plan);
    console.log(`[execute] 文件夹重命名: ${result.folderRenames}, 跳过: ${result.folderSkipped}, files.diary_name 更新行: ${result.dbUpdates}, group_prompt 更新行: ${result.promptUpdates}`);
    console.log(`[execute] 回滚日志: ${result.logPath}`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`[migrate-notebook-namespace] failed: ${error.message}`);
        process.exit(1);
    }
}

module.exports = { buildPlan, execute, sanitizeNotebookSegment, personNotebookId, sharedNotebookId };
