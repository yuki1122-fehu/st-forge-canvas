import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, getRequestHeaders } from "../../../../script.js";
import { EXT_ID, EXT_FOLDER_ID, extensionFolderPath } from "./core/constants.js";
import {
    initNovelDraw, cleanupNovelDraw
} from "./modules/draw/providers/novelai/novel-draw.js";
import {
    initSdDraw, cleanupSdDraw
} from "./modules/draw/providers/sd-webui/sd-draw.js";
import {
    initComfyDraw, cleanupComfyDraw
} from "./modules/draw/providers/comfyui/comfy-draw.js";
import {
    setupDrawGenerateInterceptor, cleanupDrawGenerateInterceptor,
    startPlaceholderWatcher, stopPlaceholderWatcher,
    startSharedDrawPreviewRuntime, stopSharedDrawPreviewRuntime,
    renderAllDrawPreviews, insertPreviewIntoRenderedMessage,
    ensureDrawImageStyles, startDrawPreviewDomObserver,
} from "./modules/draw/shared/draw-common.js";

extension_settings[EXT_ID] = extension_settings[EXT_ID] || {};
const settings = extension_settings[EXT_ID];
settings.drawProvider = settings.drawProvider || 'disabled';
settings.novelDraw = settings.novelDraw || {};

const DRAW_PROVIDER_VALUES = new Set(['disabled', 'novelai', 'sdwebui', 'comfyui']);

function normalizeDrawProvider(provider) {
    return DRAW_PROVIDER_VALUES.has(provider) ? provider : 'disabled';
}

function migrateDrawProviderSettings(targetSettings) {
    let changed = false;
    targetSettings.novelDraw ||= {};
    if (targetSettings.drawProvider === undefined) {
        targetSettings.drawProvider = targetSettings.novelDraw?.enabled ? 'novelai' : 'disabled';
        changed = true;
    }
    const normalized = normalizeDrawProvider(targetSettings.drawProvider);
    if (targetSettings.drawProvider !== normalized) {
        targetSettings.drawProvider = normalized;
        changed = true;
    }
    return changed;
}

function joinDrawTags(...parts) {
    return parts
        .filter(Boolean)
        .map(part => String(part).trim().replace(/[，、]/g, ',').replace(/^,+|,+$/g, ''))
        .filter(part => part.length > 0)
        .join(', ');
}

async function cleanupDrawProvider(provider) {
    const normalized = normalizeDrawProvider(provider);
    if (normalized === 'novelai') {
        try { await cleanupNovelDraw(); } catch (e) { }
    } else if (normalized === 'sdwebui') {
        try { await cleanupSdDraw(); } catch (e) { }
    } else if (normalized === 'comfyui') {
        try { await cleanupComfyDraw(); } catch (e) { }
    }
}

async function initActiveDrawProvider() {
    migrateDrawProviderSettings(settings);
    if (settings.drawProvider === 'novelai') {
        await initNovelDraw();
    } else if (settings.drawProvider === 'sdwebui') {
        await initSdDraw();
    } else if (settings.drawProvider === 'comfyui') {
        await initComfyDraw();
    }
}

function getProviderGenerateImagesFromText(provider) {
    if (provider === 'novelai') return window.rghxNovelDraw?.generateImagesFromText;
    if (provider === 'sdwebui') return window.rghxSdDraw?.generateImagesFromText;
    if (provider === 'comfyui') return window.rghxComfyDraw?.generateImagesFromText;
    return null;
}

function normalizeCharacterPrompts(value) {
    return Array.isArray(value)
        ? value.filter(item => item && typeof item === 'object')
        : [];
}

function buildDrawPromptData(input = {}) {
    const provider = normalizeDrawProvider(settings.drawProvider);
    const payload = typeof input === 'string' ? { prompt: input } : (input || {});
    const prompt = String(payload.prompt || payload.tags || '').trim();
    const negativePrompt = String(payload.negativePrompt || payload.negative || '').trim();
    const characterPrompts = normalizeCharacterPrompts(payload.characterPrompts);
    const charPositive = characterPrompts.map(item => item.prompt).filter(Boolean).join(', ');
    const charNegative = characterPrompts.map(item => item.uc).filter(Boolean).join(', ');

    if (provider === 'novelai') {
        const novelDraw = window.rghxNovelDraw;
        const novelSettings = novelDraw?.getSettings?.();
        const preset = novelSettings?.paramsPresets?.find(p => p.id === novelSettings.selectedParamsPresetId)
            || novelSettings?.paramsPresets?.[0];
        return {
            tags: prompt,
            positive: joinDrawTags(preset?.positivePrefix, prompt),
            negativePrompt: negativePrompt || preset?.negativePrefix || '',
            characterPrompts,
            params: preset?.params || {},
            hasParamsPreset: !!preset,
        };
    }

    if (provider === 'sdwebui') {
        const sdDraw = window.rghxSdDraw;
        const sdSettings = sdDraw?.getSettings?.() || {};
        const effective = sdDraw?.getEffectiveParams?.(sdSettings, payload.params || {}) || {};
        return {
            tags: prompt,
            positive: joinDrawTags(effective.positivePrefix || '', prompt, charPositive),
            negativePrompt: joinDrawTags(effective.negativePrefix || '', negativePrompt, charNegative),
            characterPrompts,
            params: effective,
        };
    }

    if (provider === 'comfyui') {
        const comfyDraw = window.rghxComfyDraw;
        const comfySettings = comfyDraw?.getSettings?.() || {};
        const effective = comfyDraw?.getEffectiveParams?.(comfySettings, payload.params || {}) || {};
        return {
            tags: prompt,
            positive: joinDrawTags(effective.positivePrefix || '', prompt, charPositive),
            negativePrompt: joinDrawTags(effective.negativePrefix || '', negativePrompt, charNegative),
            characterPrompts,
            params: effective,
        };
    }

    return {
        tags: prompt,
        positive: prompt,
        negativePrompt,
        characterPrompts,
        params: payload.params || {},
    };
}

function installDrawFacade() {
    window.rghxDraw = {
        getProvider() {
            return normalizeDrawProvider(settings.drawProvider);
        },
        isEnabled() {
            return normalizeDrawProvider(settings.drawProvider) !== 'disabled';
        },
        getStatus() {
            const provider = normalizeDrawProvider(settings.drawProvider);
            const enabled = provider !== 'disabled';
            const generateImagesFromText = getProviderGenerateImagesFromText(provider);
            return { provider, enabled, ready: enabled && typeof generateImagesFromText === 'function' };
        },
        buildPromptData(input = {}) {
            return buildDrawPromptData(input);
        },
        async generateImage(input = {}) {
            const provider = normalizeDrawProvider(settings.drawProvider);
            const payload = typeof input === 'string' ? { prompt: input } : (input || {});
            const promptData = buildDrawPromptData(payload);

            if (provider === 'novelai') {
                const novelDraw = window.rghxNovelDraw;
                if (!novelDraw?.generateNovelImage) throw new Error('NovelAI 画图模块未初始化');
                if (!promptData.hasParamsPreset) throw new Error('无可用的 NovelAI 参数预设');
                return novelDraw.generateNovelImage({
                    scene: promptData.positive || promptData.tags || '',
                    characterPrompts: promptData.characterPrompts || [],
                    negativePrompt: promptData.negativePrompt || '',
                    params: promptData.params || {},
                    signal: payload.signal,
                });
            }
            if (provider === 'sdwebui') {
                const sdDraw = window.rghxSdDraw;
                if (!sdDraw?.generateSdImage) throw new Error('SD WebUI 画图模块未初始化');
                return sdDraw.generateSdImage({
                    prompt: promptData.positive || promptData.tags || '',
                    negativePrompt: promptData.negativePrompt || '',
                    params: promptData.params || {},
                    signal: payload.signal,
                });
            }
            if (provider === 'comfyui') {
                const comfyDraw = window.rghxComfyDraw;
                if (!comfyDraw?.generateComfyImage) throw new Error('ComfyUI 画图模块未初始化');
                return comfyDraw.generateComfyImage({
                    prompt: promptData.positive || promptData.tags || '',
                    negativePrompt: promptData.negativePrompt || '',
                    params: promptData.params || {},
                    signal: payload.signal,
                });
            }
            throw new Error('未启用画图后端');
        },
        async generateImagesFromText(input = {}) {
            const provider = normalizeDrawProvider(settings.drawProvider);
            if (provider === 'disabled') throw new Error('未启用画图后端');
            const generateImagesFromText = getProviderGenerateImagesFromText(provider);
            if (typeof generateImagesFromText !== 'function') {
                throw new Error('当前画图模块未初始化');
            }
            return generateImagesFromText(input || {});
        },
    };
}

async function setupSettings() {
    try {
        const settingsContainer = await waitForElement("#extensions_settings2");
        if (!settingsContainer) {
            setTimeout(setupSettings, 500);
            return;
        }
        const response = await fetch(`${extensionFolderPath}/settings.html`);
        if (!response.ok) {
            console.warn('[熔光画匣画图] 设置模板加载失败，使用内联设置');
            setupInlineSettings(settingsContainer);
            return;
        }
        const settingsHtml = await response.text();
        $(settingsContainer).append(settingsHtml);

        const $provider = $("#rghx_draw_provider");
        if ($provider.length) {
            $provider.val(normalizeDrawProvider(settings.drawProvider)).on("change", async function () {
                const prev = normalizeDrawProvider(settings.drawProvider);
                const next = normalizeDrawProvider(String($(this).val() || 'disabled'));
                if (next !== $(this).val()) $(this).val(next);
                if (prev === next) return;
                await cleanupDrawProvider(prev);
                settings.drawProvider = next;
                extension_settings[EXT_ID].drawProvider = next;
                saveSettingsDebounced();
                try { await initActiveDrawProvider(); } finally { }
            });
        }

        $("#rghx_draw_open_settings").on("click", function () {
            const provider = normalizeDrawProvider(settings.drawProvider);
            if (provider === 'novelai' && window.rghxNovelDraw?.openSettings) {
                window.rghxNovelDraw.openSettings();
            } else if (provider === 'sdwebui' && window.rghxSdDraw?.openSettings) {
                window.rghxSdDraw.openSettings();
            } else if (provider === 'comfyui' && window.rghxComfyDraw?.openSettings) {
                window.rghxComfyDraw.openSettings();
            } else if (provider === 'disabled') {
                toastr?.warning?.('请先选择画图后端');
            } else {
                toastr?.warning?.('画图模块还没有初始化完成');
            }
        });
    } catch (err) {
        console.error('[熔光画匣画图] 设置初始化失败:', err);
    }
}

function setupInlineSettings(container) {
    const html = [
        '<div class="inline-drawer">',
        '  <div class="inline-drawer-toggle inline-drawer-header">',
        '    <b>熔光画匣 - AI画图</b>',
        '    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>',
        '  </div>',
        '  <div class="inline-drawer-content">',
        '    <div class="section-divider">画图后端<hr class="sysHR"></div>',
        '    <div class="flex-container alignItemsCenter rghx-setting-row rghx-select-row">',
        '      <label for="rghx_draw_provider" class="has-tooltip"',
        '             data-tooltip="选择画图渠道。使用 SD WebUI 时，需在详细设置里填写连接地址。">画图后端</label>',
        '      <select id="rghx_draw_provider" class="text_pole rghx-compact-select">',
        '        <option value="disabled">关闭</option>',
        '        <option value="novelai">NovelAI</option>',
        '        <option value="sdwebui">SD WebUI</option>',
        '        <option value="comfyui">ComfyUI</option>',
        '      </select>',
        '      <button id="rghx_draw_open_settings" class="menu_button menu_button_icon rghx-row-action"',
        '              type="button" title="打开画图详细设置">',
        '        <i class="fa-solid fa-palette"></i>',
        '        <small>画图设置</small>',
        '      </button>',
        '    </div>',
        '  </div>',
        '</div>',
    ].join('\n');
    $(container).append(html);
}

function waitForElement(selector, root = document, timeout = 10000) {
    const start = Date.now();
    return new Promise((resolve) => {
        const check = () => {
            const element = root.querySelector(selector);
            if (element) return resolve(element);
            if (Date.now() - start >= timeout) return resolve(null);
            setTimeout(check, 100);
        };
        check();
    });
}

if (migrateDrawProviderSettings(settings)) { saveSettingsDebounced(); }
installDrawFacade();
setupDrawGenerateInterceptor({ shouldStrip: () => true });
ensureDrawImageStyles();

jQuery(async () => {
    console.log('[熔光画匣画图] 插件加载中');
    try {
        const styleResp = await fetch(`${extensionFolderPath}/style.css`);
        if (styleResp.ok) {
            const styleEl = document.createElement('style');
            styleEl.textContent = await styleResp.text();
            document.head.appendChild(styleEl);
        }
    } catch (e) { console.warn('[熔光画匣画图] 样式加载失败:', e); }
    await setupSettings();
    if (normalizeDrawProvider(settings.drawProvider) !== 'disabled') {
        try {
            await initActiveDrawProvider();
            startSharedDrawPreviewRuntime();
            startPlaceholderWatcher();
        } catch (e) { console.error('[熔光画匣画图] 初始化画图失败:', e); }
    }
    function onMsgRender() { setTimeout(() => renderAllDrawPreviews(), 80); }
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMsgRender);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onMsgRender);
    eventSource.on(event_types.GENERATION_ENDED, () => {
        // 首次尝试在生成结束后立即渲染（可能占位符还未插入）
        setTimeout(() => renderAllDrawPreviews(), 500);
        // 持续重试以覆盖自动生图尚未完成的场景
        let retryCount = 0;
        const retryTimer = setInterval(() => {
            retryCount++;
            renderAllDrawPreviews();
            if (retryCount >= 20) {
                clearInterval(retryTimer);
            }
        }, 2500);
    });
    eventSource.on(event_types.MESSAGE_UPDATED, () => setTimeout(() => renderAllDrawPreviews(), 300));
    eventSource.on(event_types.MESSAGE_SWIPED, () => setTimeout(() => renderAllDrawPreviews(), 300));
    eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(() => renderAllDrawPreviews(), 200));

    // 自愈观察器：独立于画图后端，始终启用。
    // 覆盖「SillyTavern 重渲染冲刷注入 DOM」「虚拟化消息尚未挂载」「事件未触发」
    // 等导致正文残留裸 [image:slot-X] 的场景。
    startDrawPreviewDomObserver();
    // 加载时无条件先跑一次全量渲染（持久化消息 / 历史消息尤其需要）
    setTimeout(() => renderAllDrawPreviews(), 200);
});

window.renderAllDrawPreviews = renderAllDrawPreviews;
window.insertPreviewIntoRenderedMessage = insertPreviewIntoRenderedMessage;

export { normalizeDrawProvider, initActiveDrawProvider, cleanupDrawProvider };
