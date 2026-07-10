const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

const REGISTRY_VERSION = 1;

function nowIso() {
    return new Date().toISOString();
}

function sanitizeText(value, maxLength = 4000) {
    return String(value || '')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, maxLength);
}

function summarizeInline(value, maxLength = 220) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return '';
    }
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, maxLength - 1).trim()}...`;
}

function slugify(value, fallback = '') {
    const slug = String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_{2,}/g, '_');

    return slug || fallback || crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function normalizeStringArray(value, maxItems = 8) {
    const list = Array.isArray(value)
        ? value
        : String(value || '')
            .split(/\n|,|，|、|;|；/)
            .map(item => item.trim())
            .filter(Boolean);

    return [...new Set(
        list
            .map(item => String(item || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
    )].slice(0, maxItems);
}

function extractAgentName(content, fallback) {
    const heading = String(content || '').match(/^\s*#\s+(.+?)\s*$/m);
    if (heading?.[1]) {
        return sanitizeText(heading[1].replace(/[（(].*$/, ''), 80) || fallback;
    }

    const fullName = String(content || '').match(/\*\*全名[:：]\*\*\s*([^\n]+)/);
    if (fullName?.[1]) {
        return sanitizeText(fullName[1], 80) || fallback;
    }

    return fallback;
}

function extractDescription(content) {
    const lines = String(content || '')
        .split('\n')
        .map(line => line.replace(/^#+\s*/, '').trim())
        .filter(line => line && !/^[-—=]+$/.test(line) && !line.startsWith('{{'));

    return summarizeInline(lines.slice(0, 3).join(' '), 240);
}

function parsePositiveNumber(value, fallback = null) {
    if (value === null || value === undefined || value === '') {
        return fallback;
    }
    const numberValue = Number(value);
    return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function normalizeRolePayload(payload = {}, existing = null) {
    const source = sanitizeText(payload.source || existing?.source || 'manual', 80) || 'manual';
    const name = sanitizeText(payload.name || existing?.name || '未命名角色', 80) || '未命名角色';
    const id = sanitizeText(
        payload.id || existing?.id || `${source}_${slugify(name)}`,
        120
    ).replace(/\s+/g, '_');

    const roleSpec = payload.role_spec && typeof payload.role_spec === 'object'
        ? payload.role_spec
        : {};

    const description = sanitizeText(
        payload.description || roleSpec.description || existing?.description || '',
        360
    );

    const templateContent = sanitizeText(
        payload.template_content
        || payload.template
        || roleSpec.template_content
        || roleSpec.template
        || existing?.template_content
        || '',
        30000
    );

    const persona = sanitizeText(
        payload.persona || roleSpec.persona || existing?.persona || description,
        8000
    );

    const responsibilities = normalizeStringArray(
        payload.responsibilities || roleSpec.responsibilities || existing?.responsibilities || [],
        8
    );

    const collaborationGuide = sanitizeText(
        payload.collaboration_guide
        || payload.collaborationGuide
        || roleSpec.collaboration_guide
        || roleSpec.collaborationGuide
        || existing?.collaboration_guide
        || '',
        1200
    );

    const voiceStyle = sanitizeText(
        payload.voice_style
        || payload.voiceStyle
        || roleSpec.voice_style
        || roleSpec.voiceStyle
        || existing?.voice_style
        || '',
        240
    );

    const memory = payload.memory || roleSpec.memory || existing?.memory || null;

    return {
        id,
        name,
        source,
        description,
        avatar: sanitizeText(payload.avatar || existing?.avatar || '', 500),
        tag: sanitizeText(payload.tag || roleSpec.tag || existing?.tag || '', 240),
        active: payload.active ?? existing?.active ?? true,
        model: sanitizeText(payload.model || roleSpec.model || existing?.model || '', 160),
        temperature: payload.temperature ?? roleSpec.temperature ?? existing?.temperature ?? null,
        max_tokens: parsePositiveNumber(payload.max_tokens ?? roleSpec.max_tokens ?? existing?.max_tokens),
        output_tokens: parsePositiveNumber(payload.output_tokens ?? roleSpec.output_tokens ?? existing?.output_tokens),
        context_token_limit: parsePositiveNumber(payload.context_token_limit ?? roleSpec.context_token_limit ?? existing?.context_token_limit),
        persona,
        responsibilities,
        collaboration_guide: collaborationGuide,
        voice_style: voiceStyle,
        memory,
        invite_prompt: sanitizeText(
            payload.invite_prompt
            || payload.invitePrompt
            || roleSpec.invite_prompt
            || roleSpec.invitePrompt
            || existing?.invite_prompt
            || '',
            600
        ),
        template_content: templateContent || persona || description,
        template_file: sanitizeText(payload.template_file || existing?.template_file || '', 500),
        template_ext: sanitizeText(payload.template_ext || existing?.template_ext || '.txt', 20),
        sort_order: payload.sort_order ?? existing?.sort_order ?? 999,
        metadata: {
            ...(existing?.metadata || {}),
            ...(payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {})
        },
        created_at: existing?.created_at || nowIso(),
        updated_at: nowIso()
    };
}

class RoleCoreManager {
    constructor(options = {}) {
        this.baseDir = options.baseDir || path.join(__dirname, '..', 'RoleCore');
        this.registryPath = options.registryPath || path.join(this.baseDir, 'registry.json');
        this.agentDir = options.agentDir || path.join(__dirname, '..', 'Agent');
        this.projectRoot = options.projectRoot || path.join(__dirname, '..');
    }

    async ensureRegistry() {
        await fs.mkdir(this.baseDir, { recursive: true });
        if (!fsSync.existsSync(this.registryPath)) {
            await this.writeRegistry({
                version: REGISTRY_VERSION,
                updated_at: nowIso(),
                roles: []
            });
        }
    }

    async readRegistry() {
        await this.ensureRegistry();
        const raw = await fs.readFile(this.registryPath, 'utf8');
        const parsed = JSON.parse(raw || '{}');

        if (Array.isArray(parsed)) {
            return {
                version: REGISTRY_VERSION,
                updated_at: nowIso(),
                roles: parsed
            };
        }

        return {
            version: parsed.version || REGISTRY_VERSION,
            updated_at: parsed.updated_at || nowIso(),
            roles: Array.isArray(parsed.roles) ? parsed.roles : []
        };
    }

    async writeRegistry(registry) {
        await fs.mkdir(this.baseDir, { recursive: true });
        const payload = {
            version: REGISTRY_VERSION,
            updated_at: nowIso(),
            roles: Array.isArray(registry.roles) ? registry.roles : []
        };
        const tmpPath = `${this.registryPath}.tmp`;
        await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
        await fs.rename(tmpPath, this.registryPath);
        return payload;
    }

    async loadRegistry() {
        return this.readRegistry();
    }

    async loadTemplateContent(role) {
        if (role.template_content) {
            return role.template_content;
        }
        if (!role.template_file) {
            return '';
        }

        const normalizedTemplatePath = String(role.template_file).replace(/^[/\\]+/, '');
        const templatePath = path.resolve(this.baseDir, normalizedTemplatePath);
        const basePathWithSep = `${path.resolve(this.baseDir)}${path.sep}`;
        if (!templatePath.startsWith(basePathWithSep)) {
            return '';
        }

        try {
            return await fs.readFile(templatePath, 'utf8');
        } catch (error) {
            return '';
        }
    }

    async listNativeRoles() {
        if (!fsSync.existsSync(this.agentDir)) {
            return [];
        }

        const entries = await fs.readdir(this.agentDir, { withFileTypes: true });
        const files = entries
            .filter(entry => entry.isFile() && /\.(txt|md)$/i.test(entry.name))
            .map(entry => entry.name)
            .sort((a, b) => a.localeCompare(b));

        const roles = [];
        for (const filename of files) {
            const filePath = path.join(this.agentDir, filename);
            const content = await fs.readFile(filePath, 'utf8');
            const basename = path.basename(filename, path.extname(filename));
            const name = extractAgentName(content, basename);
            const description = extractDescription(content);

            roles.push(this.toPublicRole({
                id: basename,
                name,
                source: 'vcp_agent',
                description,
                tag: basename,
                persona: content,
                responsibilities: [],
                collaboration_guide: '',
                voice_style: '',
                invite_prompt: `接下来请作为${name}发言。`,
                template_content: content,
                metadata: {
                    file: filename,
                    native_agent: true
                },
                created_at: null,
                updated_at: null
            }, { isNative: true }));
        }

        return roles;
    }

    async hydrateRole(role) {
        const templateContent = await this.loadTemplateContent(role);
        return {
            ...role,
            template_content: templateContent || role.template_content || role.persona || role.description || ''
        };
    }

    toPublicRole(role, options = {}) {
        const isNative = Boolean(options.isNative || role.is_native);
        const templateContent = role.template_content || '';
        const roleSpec = {
            name: role.name,
            description: role.description || '',
            persona: role.persona || '',
            responsibilities: role.responsibilities || [],
            collaboration_guide: role.collaboration_guide || '',
            voice_style: role.voice_style || '',
            memory: role.memory || null,
            invite_prompt: role.invite_prompt || '',
            template_content: templateContent,
            tag: role.tag || '',
            model: role.model || '',
            temperature: role.temperature ?? null,
            max_tokens: role.max_tokens ?? null,
            output_tokens: role.output_tokens ?? null,
            context_token_limit: role.context_token_limit ?? null
        };

        return {
            id: role.id,
            name: role.name,
            source: role.source || 'manual',
            description: role.description || '',
            avatar: role.avatar || '',
            tag: role.tag || '',
            active: role.active ?? true,
            model: role.model || '',
            temperature: role.temperature ?? null,
            max_tokens: role.max_tokens ?? null,
            output_tokens: role.output_tokens ?? null,
            context_token_limit: role.context_token_limit ?? null,
            persona: role.persona || '',
            responsibilities: role.responsibilities || [],
            collaboration_guide: role.collaboration_guide || '',
            voice_style: role.voice_style || '',
            memory: role.memory || null,
            invite_prompt: role.invite_prompt || '',
            template_content: templateContent,
            template_file: role.template_file || '',
            template_ext: role.template_ext || '',
            sort_order: role.sort_order ?? 999,
            metadata: role.metadata || {},
            role_spec: roleSpec,
            is_native: isNative,
            created_at: role.created_at || null,
            updated_at: role.updated_at || null
        };
    }

    async listImportedRoles() {
        const registry = await this.readRegistry();
        const hydratedRoles = await Promise.all(registry.roles.map(role => this.hydrateRole(role)));
        return hydratedRoles.map(role => this.toPublicRole(role));
    }

    async listRoles() {
        const [nativeRoles, importedRoles] = await Promise.all([
            this.listNativeRoles(),
            this.listImportedRoles()
        ]);
        return [...nativeRoles, ...importedRoles];
    }

    async getRole(roleId) {
        const normalizedId = String(roleId || '').trim();
        if (!normalizedId) {
            return null;
        }

        const roles = await this.listRoles();
        return roles.find(role => role.id === normalizedId)
            || roles.find(role => String(role.id).toLowerCase() === normalizedId.toLowerCase())
            || null;
    }

    async getRoleById(roleId) {
        return this.getRole(roleId);
    }

    async importRole(payload = {}) {
        const registry = await this.readRegistry();
        const existingIndex = registry.roles.findIndex(role => role.id === payload.id);
        const existing = existingIndex >= 0 ? registry.roles[existingIndex] : null;
        const normalized = normalizeRolePayload(payload, existing);
        const nextRoles = [...registry.roles];

        const replaceIndex = nextRoles.findIndex(role => role.id === normalized.id);
        if (replaceIndex >= 0) {
            nextRoles[replaceIndex] = normalized;
        } else {
            nextRoles.push(normalized);
        }

        await this.writeRegistry({
            ...registry,
            roles: nextRoles.sort((a, b) => String(a.name).localeCompare(String(b.name)))
        });

        return this.toPublicRole(normalized);
    }
}

const defaultRoleCoreManager = new RoleCoreManager();

module.exports = defaultRoleCoreManager;
module.exports.RoleCoreManager = RoleCoreManager;
module.exports.defaultRoleCoreManager = defaultRoleCoreManager;
module.exports.normalizeRolePayload = normalizeRolePayload;
module.exports.slugify = slugify;
module.exports.sanitizeText = sanitizeText;
module.exports.summarizeInline = summarizeInline;
