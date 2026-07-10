const roleCoreManager = require('./roleCoreManager');

const DEFAULT_ROLE_TURN_MODELS = [
    'bytedance-seed/seed-1.6-flash',
    'qwen/qwen3.5-flash-02-23',
    'z-ai/glm-4.7-flash',
    'qwen/qwen3.6-plus-preview:free'
];
const DEFAULT_GROUPCHAT_MAX_OUTPUT_TOKENS = 320;
const DEFAULT_GROUPCHAT_REPLY_CHAR_LIMIT = 220;

function uniqueNonEmpty(values = []) {
    return [...new Set(
        values
            .flatMap(value => String(value || '').split(','))
            .map(value => value.trim())
            .filter(Boolean)
    )];
}

function extractTextContent(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .filter(item => item && item.type === 'text' && typeof item.text === 'string')
            .map(item => item.text)
            .join('\n');
    }

    if (content && typeof content === 'object') {
        return content.text || '';
    }

    return '';
}

function buildMemoryInstruction(memory, memoryScope = {}, writePolicy = {}) {
    if (!memory) {
        return '';
    }

    const lines = ['记忆规则：'];

    if (memory.privateNotebook) {
        lines.push(`- 你的私有记忆本是：${memory.privateNotebook}。`);
    }

    if (memory.knowledgeNotebook) {
        lines.push(`- 你的知识记忆本是：${memory.knowledgeNotebook}。`);
    }

    if (Array.isArray(memory.sharedNotebooks) && memory.sharedNotebooks.length > 0) {
        lines.push(`- 可访问的共享记忆本：${memory.sharedNotebooks.join('、')}。`);
    }

    lines.push('- 不要读取或写入其他角色的私有记忆。');

    if (memory.privateWritebackMaid) {
        lines.push(`- 需要沉淀个人长期记忆时，写回署名使用：${memory.privateWritebackMaid}。`);
    }

    if (memory.sharedWritebackMaid) {
        lines.push(`- 形成团队稳定结论时，可写入共享记忆，署名使用：${memory.sharedWritebackMaid}。`);
    }

    if (memoryScope && typeof memoryScope === 'object') {
        const scopeLines = [];
        if (memoryScope.allow_private === false) {
            scopeLines.push('本轮禁止读取私有记忆');
        }
        if (memoryScope.allow_knowledge === false) {
            scopeLines.push('本轮禁止读取知识记忆');
        }
        if (Array.isArray(memoryScope.shared_notebooks) && memoryScope.shared_notebooks.length > 0) {
            scopeLines.push(`本轮允许的共享记忆：${memoryScope.shared_notebooks.join('、')}`);
        }
        if (scopeLines.length > 0) {
            lines.push(`- 额外访问范围：${scopeLines.join('；')}。`);
        }
    }

    if (writePolicy && typeof writePolicy === 'object') {
        const policyLines = [];
        if (writePolicy.allow_private_write === false) {
            policyLines.push('禁止写私有记忆');
        }
        if (writePolicy.allow_shared_write === false) {
            policyLines.push('禁止写共享记忆');
        }
        if (policyLines.length > 0) {
            lines.push(`- 本轮写回约束：${policyLines.join('；')}。`);
        }
    }

    return lines.join('\n');
}

function normalizeBooleanDefault(value, fallback = true) {
    return typeof value === 'boolean' ? value : fallback;
}

function readBoundedIntEnv(name, fallback, min, max) {
    const rawValue = Number(process.env[name]);
    if (!Number.isFinite(rawValue)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, Math.floor(rawValue)));
}

function resolveExecutionMode(payload = {}) {
    return String(payload?.execution_context?.mode || '').trim().toLowerCase();
}

function isGroupChatExecution(payload = {}) {
    return resolveExecutionMode(payload) === 'group_chat';
}

function buildGroupChatReplyContract(payload = {}) {
    if (!isGroupChatExecution(payload)) {
        return '';
    }

    const charLimit = readBoundedIntEnv(
        'GROUPCHAT_ROLE_REPLY_CHAR_LIMIT',
        DEFAULT_GROUPCHAT_REPLY_CHAR_LIMIT,
        60,
        600
    );

    return [
        '群聊输出约束：',
        '- 只输出 1 到 3 句短回复，优先一句话说清楚。',
        '- 只补充新增信息；如果没有新增价值，直接明确说暂时没有补充。',
        '- 不要重复上下文，不要写标题、编号、大纲、总结套话或“作为某某我认为”。',
        `- 总长度尽量控制在 ${charLimit} 个中文字符以内。`
    ].join('\n');
}

function resolveMaxOutputTokens(roleSpec = {}, payload = {}) {
    const configuredTokens = Number(roleSpec.output_tokens || 2048);
    const normalizedConfiguredTokens = Number.isFinite(configuredTokens)
        ? Math.max(64, Math.min(8192, Math.floor(configuredTokens)))
        : 2048;

    if (!isGroupChatExecution(payload)) {
        return normalizedConfiguredTokens;
    }

    const groupChatTokenLimit = readBoundedIntEnv(
        'GROUPCHAT_ROLE_MAX_OUTPUT_TOKENS',
        DEFAULT_GROUPCHAT_MAX_OUTPUT_TOKENS,
        64,
        1024
    );

    return Math.min(normalizedConfiguredTokens, groupChatTokenLimit);
}

function buildMemoryTrace(roleSpec = {}, payload = {}) {
    const memory = roleSpec.memory && typeof roleSpec.memory === 'object'
        ? roleSpec.memory
        : {};
    const memoryScope = payload.memory_scope && typeof payload.memory_scope === 'object'
        ? payload.memory_scope
        : {};
    const writePolicy = payload.write_policy && typeof payload.write_policy === 'object'
        ? payload.write_policy
        : {};
    const sharedNotebooks = Array.isArray(memoryScope.shared_notebooks) && memoryScope.shared_notebooks.length > 0
        ? memoryScope.shared_notebooks
        : (Array.isArray(memory.sharedNotebooks) ? memory.sharedNotebooks : []);

    return {
        role_id: roleSpec.id || payload.role_id || '',
        role_name: roleSpec.name || '',
        private_notebook: memory.privateNotebook || memory.private_notebook || '',
        knowledge_notebook: memory.knowledgeNotebook || memory.knowledge_notebook || '',
        shared_notebooks: sharedNotebooks.filter(Boolean),
        read_policy: {
            allow_private: normalizeBooleanDefault(memoryScope.allow_private, true),
            allow_knowledge: normalizeBooleanDefault(memoryScope.allow_knowledge, true),
            allow_shared: sharedNotebooks.length > 0
        },
        write_policy: {
            allow_private_write: normalizeBooleanDefault(writePolicy.allow_private_write, true),
            allow_shared_write: normalizeBooleanDefault(writePolicy.allow_shared_write, true)
        },
        writeback: {
            private_maid: memory.privateWritebackMaid || memory.private_writeback_maid || '',
            shared_maid: memory.sharedWritebackMaid || memory.shared_writeback_maid || ''
        },
        execution_context: payload.execution_context && typeof payload.execution_context === 'object'
            ? payload.execution_context
            : {},
        trace_source: 'role-turn-memory-protocol',
        storage_owner: 'VCPToolBox'
    };
}

function buildRoleSections(roleSpec, payload = {}) {
    const sections = [];

    if (payload.user_prompt) {
        sections.push(payload.user_prompt);
    }

    if (payload.group_prompt) {
        sections.push(payload.group_prompt);
    }

    if (roleSpec.template_content) {
        sections.push(roleSpec.template_content.trim());
    }

    if (roleSpec.persona) {
        sections.push(`角色定位：${roleSpec.persona}`);
    }

    if (Array.isArray(roleSpec.responsibilities) && roleSpec.responsibilities.length > 0) {
        sections.push(`职责范围：\n- ${roleSpec.responsibilities.join('\n- ')}`);
    }

    if (roleSpec.collaboration_guide) {
        sections.push(`协作规则：${roleSpec.collaboration_guide}`);
    }

    if (roleSpec.voice_style) {
        sections.push(`表达风格：${roleSpec.voice_style}`);
    }

    if (payload.phase) {
        sections.push(`当前阶段：${payload.phase}`);
    }

    const memorySection = buildMemoryInstruction(
        roleSpec.memory,
        payload.memory_scope,
        payload.write_policy
    );
    if (memorySection) {
        sections.push(memorySection);
    }

    if (payload.execution_context && typeof payload.execution_context === 'object') {
        const executionLines = [];
        if (payload.execution_context.mode) {
            executionLines.push(`运行模式：${payload.execution_context.mode}`);
        }
        if (payload.execution_context.group_profile_name) {
            executionLines.push(`当前群组模板：${payload.execution_context.group_profile_name}`);
        }
        if (executionLines.length > 0) {
            sections.push(executionLines.join('\n'));
        }
    }

    const groupChatReplyContract = buildGroupChatReplyContract(payload);
    if (groupChatReplyContract) {
        sections.push(groupChatReplyContract);
    }

    return sections.filter(Boolean).join('\n\n');
}

function toChatMessage(message) {
    const senderName = message.name || message.speaker_name || '';
    const textContent = extractTextContent(message.content);
    const imageUrl = message?.content?.image;
    const prefix = senderName ? `${senderName}: ` : '';

    if (imageUrl) {
        return {
            role: message.role,
            content: [
                { type: 'text', text: textContent ? `${prefix}${textContent}` : `${prefix}[图片]` },
                { type: 'image_url', image_url: { url: imageUrl } }
            ]
        };
    }

    return {
        role: message.role,
        content: `${prefix}${textContent}`.trim()
    };
}

function buildInvitePrompt(roleSpec, payload = {}) {
    const phaseText = payload.phase ? `当前阶段是 ${payload.phase}。` : '';
    const basePrompt = roleSpec.invite_prompt
        ? roleSpec.invite_prompt
        : `接下来请作为${roleSpec.name}发言。${phaseText}优先回答自己职责范围内的问题，保持简洁、口语化，不要输出额外聊天标识头。`;
    const groupChatSuffix = isGroupChatExecution(payload)
        ? '本轮只给 1 到 3 句短回复，不复述前文，不加标题。'
        : '';

    return [basePrompt, groupChatSuffix].filter(Boolean).join('\n');
}

function normalizeInlineRole(role = {}) {
    return {
        id: role.id || '',
        name: role.name || '临时角色',
        source: role.source || 'inline',
        description: role.description || '',
        avatar: role.avatar || '',
        tag: role.tag || '',
        model: role.model || '',
        max_tokens: role.max_tokens || role.maxTokens || 1000000,
        output_tokens: role.output_tokens || role.outputTokens || 2048,
        temperature: role.temperature ?? 0.7,
        context_token_limit: role.context_token_limit || role.contextTokenLimit || 1000000,
        invite_prompt: role.invite_prompt || '',
        persona: role.persona || '',
        responsibilities: Array.isArray(role.responsibilities) ? role.responsibilities : [],
        collaboration_guide: role.collaboration_guide || '',
        voice_style: role.voice_style || '',
        memory: role.memory || null,
        template_content: role.template_content || ''
    };
}

class RoleTurnService {
    buildModelOrder(roleSpec) {
        return uniqueNonEmpty([
            roleSpec.model,
            process.env.DEFAULT_ROLE_MODEL,
            process.env.GROUPCHAT_CORE_MODEL,
            process.env.GROUPCHAT_ROLE_MODEL,
            process.env.ROLE_CORE_FALLBACK_MODELS,
            DEFAULT_ROLE_TURN_MODELS
        ]);
    }

    async requestChatCompletion({ apiBaseUrl, apiKey, roleSpec, messages, maxTokens }) {
        const failures = [];
        const modelOrder = this.buildModelOrder(roleSpec);

        for (const model of modelOrder) {
            const requestBody = {
                model,
                messages,
                max_tokens: maxTokens,
                temperature: roleSpec.temperature ?? 0.7,
                contextTokenLimit: roleSpec.context_token_limit || 1000000,
                stream: false
            };

            const response = await fetch(`${apiBaseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`
                },
                body: JSON.stringify(requestBody)
            });

            const responseText = await response.text();
            let parsed = null;
            try {
                parsed = responseText ? JSON.parse(responseText) : null;
            } catch (error) {
                parsed = null;
            }

            if (response.ok) {
                return {
                    requestBody,
                    rawResponse: parsed,
                    selectedModel: model,
                    failures
                };
            }

            const errorMessage =
                parsed?.error?.message ||
                parsed?.message ||
                parsed?.error ||
                response.statusText ||
                'unknown error';
            failures.push(`${model}: ${errorMessage}`);
        }

        const err = new Error(`role turn failed: ${failures.join(' | ') || 'no model endpoints available'}`);
        err.status = 502;
        err.payload = { failures };
        throw err;
    }

    async execute(payload = {}, options = {}) {
        const roleSpec = payload.inline_role
            ? normalizeInlineRole(payload.inline_role)
            : await roleCoreManager.getRoleById(payload.role_id);

        if (!roleSpec) {
            throw new Error(`role not found: ${payload.role_id || 'inline_role'}`);
        }

        const apiBaseUrl = options.apiBaseUrl || process.env.ROLE_CORE_PROXY_URL || `http://127.0.0.1:${process.env.PORT || 6005}`;
        const apiKey = options.apiKey || process.env.Key;
        if (!apiKey) {
            throw new Error('missing VCPToolBox bearer key');
        }

        const messages = [];
        const systemPrompt = buildRoleSections(roleSpec, payload);
        if (systemPrompt.trim()) {
            messages.push({ role: 'system', content: systemPrompt });
        }

        for (const message of payload.messages || []) {
            if (!message || !message.role) {
                continue;
            }
            messages.push(toChatMessage(message));
        }

        messages.push({ role: 'user', content: buildInvitePrompt(roleSpec, payload) });
        const maxTokens = resolveMaxOutputTokens(roleSpec, payload);

        const completion = await this.requestChatCompletion({
            apiBaseUrl,
            apiKey,
            roleSpec,
            messages,
            maxTokens
        });

        const assistantContent = completion.rawResponse?.choices?.[0]?.message?.content || '';
        return {
            role: roleSpec,
            memory_trace: buildMemoryTrace(roleSpec, payload),
            request_body: completion.requestBody,
            raw_response: completion.rawResponse,
            selected_model: completion.selectedModel,
            fallback_failures: completion.failures,
            message: {
                role: 'assistant',
                speaker_id: roleSpec.id,
                speaker_name: roleSpec.name,
                content: {
                    text: assistantContent
                }
            }
        };
    }
}

module.exports = new RoleTurnService();
