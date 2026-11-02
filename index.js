import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    saveChat,
    updateMessageBlock,
    printMessages,
    eventSource,
    event_types,
} from '../../../../script.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';

const EXT_NAME = 'yihuajiemu';

let idSeq = 0;
const genId = () => 'g' + Date.now().toString(36) + (idSeq++).toString(36);
let normalized = false;

function normalizeRules(rules) {
    if (!Array.isArray(rules)) return [];
    return rules
        .map((r) => ({
            find: String(r?.find ?? ''),
            replace: String(r?.replace ?? ''),
            enabled: r?.enabled !== false,
        }))
        .filter((r) => r.find);
}

function legacyRulesToArray(raw) {
    if (typeof raw === 'string') {
        const out = [];
        for (const line of raw.split(/\r?\n/)) {
            const text = line.trim();
            if (!text || text.startsWith('#')) continue;
            const idx = text.indexOf('=>');
            if (idx === -1) {
                out.push({ find: text, replace: '', enabled: true });
            } else {
                const find = text.slice(0, idx).trim();
                if (find) out.push({ find, replace: text.slice(idx + 2).trim(), enabled: true });
            }
        }
        return out;
    }
    return normalizeRules(raw);
}

function getSettings() {
    if (!extension_settings[EXT_NAME]) extension_settings[EXT_NAME] = {};
    const s = extension_settings[EXT_NAME];
    if (!normalized) {
        if (!Array.isArray(s.groups)) {
            const legacy = legacyRulesToArray(s.rules);
            s.groups = [{ id: genId(), name: '默认', enabled: true, rules: legacy }];
            delete s.rules;
        }
        s.groups = s.groups.map((g) => ({
            id: g.id ?? genId(),
            name: String(g.name ?? '未命名'),
            enabled: g.enabled !== false,
            rules: normalizeRules(g.rules),
        }));
        if (!s.activeGroupId || !s.groups.some((g) => g.id === s.activeGroupId)) {
            s.activeGroupId = s.groups[0]?.id ?? null;
        }
        normalized = true;
    }
    return s;
}

function getEnabledRules() {
    const out = [];
    for (const group of getSettings().groups) {
        if (!group.enabled) continue;
        for (const rule of group.rules) {
            if (rule.enabled && rule.find) out.push(rule);
        }
    }
    return out;
}

function saveSettings() {
    saveSettingsDebounced();
}

function applyRulesToText(text, rules) {
    if (typeof text !== 'string' || !text) return text;
    let out = text;
    for (const rule of rules) {
        if (out.includes(rule.find)) out = out.split(rule.find).join(rule.replace);
    }
    return out;
}

function applyToMessage(msg, rules) {
    let changed = false;
    if (typeof msg?.mes === 'string') {
        const next = applyRulesToText(msg.mes, rules);
        if (next !== msg.mes) { msg.mes = next; changed = true; }
    }
    if (Array.isArray(msg?.swipes)) {
        for (let i = 0; i < msg.swipes.length; i++) {
            if (typeof msg.swipes[i] !== 'string') continue;
            const next = applyRulesToText(msg.swipes[i], rules);
            if (next !== msg.swipes[i]) { msg.swipes[i] = next; changed = true; }
        }
    }
    return changed;
}

function countMatches(chatArr, rules) {
    let messages = 0;
    let hits = 0;
    for (const msg of chatArr) {
        let changed = false;
        const texts = [msg?.mes, ...(Array.isArray(msg?.swipes) ? msg.swipes : [])];
        for (const text of texts) {
            if (typeof text !== 'string') continue;
            for (const rule of rules) {
                if (text.includes(rule.find)) {
                    changed = true;
                    hits += text.split(rule.find).length - 1;
                }
            }
        }
        if (changed) messages++;
    }
    return { messages, hits };
}

function exportRules() {
    try {
        const settings = getSettings();
        const data = {
            app: 'yihuajiemu',
            version: 1,
            exportedAt: new Date().toISOString(),
            groups: settings.groups.map((g) => ({
                name: g.name,
                enabled: g.enabled,
                rules: g.rules.map((r) => ({ find: r.find, replace: r.replace, enabled: r.enabled })),
            })),
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = '移花接木-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toastr.success('已导出规则文件');
    } catch (error) {
        console.error('[移花接木] 导出失败', error);
        toastr.error('导出失败，请看控制台');
    }
}

let busy = false;

async function handleSingleMessage(messageId) {
    try {
        if (busy) return;
        const id = Number(messageId);
        if (!Number.isInteger(id) || id < 0) return;
        const rules = getEnabledRules();
        if (!rules.length) return;
        const chatArr = getContext().chat;
        const msg = chatArr?.[id];
        if (!msg) return;
        if (!applyToMessage(msg, rules)) return;
        busy = true;
        try {
            await saveChat();
            updateMessageBlock(id, msg);
        } finally {
            busy = false;
        }
    } catch (error) {
        console.error('[移花接木] 处理消息失败', error);
    }
}

async function scanCurrentChat() {
    if (busy) return 0;
    const rules = getEnabledRules();
    if (!rules.length) {
        toastr.warning('还没有启用任何规则');
        return 0;
    }
    const chatArr = getContext().chat;
    if (!Array.isArray(chatArr) || !chatArr.length) {
        toastr.warning('当前聊天是空的');
        return 0;
    }
    let changed = 0;
    for (const msg of chatArr) {
        if (applyToMessage(msg, rules)) changed++;
    }
    if (!changed) return 0;
    busy = true;
    try {
        await saveChat();
        await printMessages();
        toastr.success('已永久替换 ' + changed + ' 条消息');
    } catch (error) {
        console.error('[移花接木] 扫描失败', error);
        toastr.error('替换失败，请看控制台');
    } finally {
        busy = false;
    }
    return changed;
}

function openPanel() {
    const settings = getSettings();
    const container = $('<div class="yhjm-panel"></div>');
    const layout = $('<div class="yhjm-layout"></div>');
    const left = $('<div class="yhjm-left"></div>');
    const right = $('<div class="yhjm-right"></div>');

    const searchRow = $('<div class="yhjm-search-row"></div>');
    const search = $('<input class="text_pole yhjm-search" type="text" placeholder="搜索组…">');
    const addGroup = $('<button class="menu_button yhjm-icon-btn" title="新建组"></button>').append('<i class="fa-solid fa-plus"></i>');
    searchRow.append(search, addGroup);
    const list = $('<div class="yhjm-group-list"></div>');
    const groupName = $('<input class="text_pole yhjm-group-name" type="text" placeholder="组名">');
    const rulesBox = $('<div class="yhjm-rules"></div>');
    const actions = $('<div class="yhjm-actions"></div>');
    const result = $('<div class="yhjm-result"></div>');

    let selectedId = settings.activeGroupId;
    let filter = '';

    const selectedGroup = () => settings.groups.find((g) => g.id === selectedId) ?? settings.groups[0] ?? null;

    function renderRuleRow(rule, onChange, onDelete) {
        const row = $('<div class="yhjm-rule"></div>');
        const find = $('<input class="text_pole yhjm-find" type="text" placeholder="查找">').val(rule.find);
        const arrow = $('<span class="yhjm-arrow">→</span>');
        const replace = $('<input class="text_pole yhjm-replace" type="text" placeholder="替换（留空 = 删除）">').val(rule.replace);
        const enabled = $('<input type="checkbox" class="yhjm-enabled" title="启用">').prop('checked', rule.enabled);
        const del = $('<button class="menu_button yhjm-icon-btn" title="删除这条规则"></button>').append('<i class="fa-solid fa-trash"></i>');

        find.on('input', () => { rule.find = String(find.val()).trim(); onChange(); });
        replace.on('input', () => { rule.replace = String(replace.val()); onChange(); });
        enabled.on('change', () => { rule.enabled = enabled.prop('checked'); onChange(); });
        del.on('click', onDelete);

        row.append(find, arrow, replace, enabled, del);
        return row;
    }

    function renderList() {
        list.empty();
        const groups = filter
            ? settings.groups.filter((g) => (g.name || '').toLowerCase().includes(filter.toLowerCase()))
            : settings.groups;
        if (!groups.length) {
            list.append($('<p class="yhjm-empty"></p>').text('没有匹配的组'));
            return;
        }
        for (const group of groups) {
            const row = $('<div class="yhjm-group-item"></div>');
            if (group.id === selectedId) row.addClass('active');

            const name = $('<span class="yhjm-group-item-name"></span>').text(group.name || '未命名');
            name.on('click', () => {
                selectedId = group.id;
                settings.activeGroupId = group.id;
                saveSettings();
                renderAll();
            });
            name.on('dblclick', (event) => {
                event.stopPropagation();
                const input = $('<input class="text_pole yhjm-rename" type="text">').val(group.name);
                name.replaceWith(input);
                input.trigger('focus').select?.();
                const commit = () => {
                    group.name = String(input.val()).trim() || '未命名';
                    saveSettings();
                    renderAll();
                };
                input.on('blur', commit);
                input.on('keydown', (ev) => {
                    if (ev.key === 'Enter') input.trigger('blur');
                    if (ev.key === 'Escape') renderAll();
                });
            });

            const del = $('<button class="yhjm-group-del yhjm-icon-btn" title="删除这个组"></button>').append('<i class="fa-solid fa-trash"></i>');
            del.on('click', (event) => {
                event.stopPropagation();
                if (settings.groups.length <= 1) {
                    toastr.warning('至少要保留一个组');
                    return;
                }
                settings.groups = settings.groups.filter((g) => g !== group);
                if (selectedId === group.id) {
                    selectedId = settings.groups[0].id;
                    settings.activeGroupId = selectedId;
                }
                saveSettings();
                renderAll();
            });

            const enable = $('<input type="checkbox" class="yhjm-group-enable" title="启用这个组">').prop('checked', group.enabled);
            enable.on('change', () => {
                group.enabled = enable.prop('checked');
                saveSettings();
            });

            row.append(name, enable, del);
            list.append(row);
        }
    }

    function renderRight() {
        const group = selectedGroup();
        if (!group) return;
        rulesBox.empty();
        for (const rule of group.rules) {
            rulesBox.append(renderRuleRow(
                rule,
                () => saveSettings(),
                () => {
                    group.rules = group.rules.filter((r) => r !== rule);
                    saveSettings();
                    renderRight();
                },
            ));
        }
        if (!group.rules.length) {
            rulesBox.append($('<p class="yhjm-empty"></p>').text('这个组还没有规则。'));
        }
    }

    function renderAll() {
        renderList();
        renderRight();
    }

    search.on('input', () => {
        filter = String(search.val());
        renderList();
    });

    function openNewGroupDialog() {
        const box = $('<div class="yhjm-rule-editor"></div>');
        const name = $('<input class="text_pole" type="text" placeholder="组名">').val('组' + (settings.groups.length + 1));
        box.append($('<label class="yhjm-editor-label"></label>').text('新组名'), name);
        const popup = new Popup(box, POPUP_TYPE.CONFIRM, '', {
            okButton: '创建',
            cancelButton: '取消',
        });
        popup.show().then((res) => {
            if (res !== POPUP_RESULT.AFFIRMATIVE) return;
            const group = {
                id: genId(),
                name: String(name.val()).trim() || ('组' + (settings.groups.length + 1)),
                enabled: true,
                rules: [],
            };
            settings.groups.push(group);
            selectedId = group.id;
            settings.activeGroupId = group.id;
            saveSettings();
            renderAll();
        });
    }

    addGroup.on('click', openNewGroupDialog);


    groupName.on('input', () => {
        const group = selectedGroup();
        if (!group) return;
        group.name = String(groupName.val());
        saveSettings();
        renderList();
    });

    const addRule = $('<button class="menu_button yhjm-icon-btn" title="添加规则"></button>').append('<i class="fa-solid fa-plus"></i>');
    addRule.on('click', () => {
        const group = selectedGroup();
        if (!group) return;
        group.rules.push({ find: '', replace: '', enabled: true });
        saveSettings();
        renderRight();
    });

    const previewBtn = $('<button class="menu_button"></button>').text('预览');
    previewBtn.on('click', () => {
        const rules = getEnabledRules();
        if (!rules.length) { result.text('没有启用的规则。'); return; }
        const { messages, hits } = countMatches(getContext().chat ?? [], rules);
        result.text(messages ? '当前聊天会改到 ' + messages + ' 条消息、共 ' + hits + ' 处。' : '当前聊天没有命中任何规则。');
    });

    const scanBtn = $('<button class="menu_button"></button>').text('扫描当前聊天');
    scanBtn.on('click', async () => {
        const changed = await scanCurrentChat();
        result.text(changed ? '已永久替换 ' + changed + ' 条消息。' : '没有需要替换的内容。');
    });

    const fileInput = $('<input type="file" accept=".json,application/json" style="display:none">');
    fileInput.on('change', () => {
        const file = fileInput[0]?.files?.[0];
        if (file) importFromFile(file);
        fileInput.val('');
    });

    const exportBtn = $('<button class="menu_button"></button>').text('导出');
    exportBtn.on('click', exportRules);
    const importBtn = $('<button class="menu_button"></button>').text('导入');
    importBtn.on('click', () => fileInput.click());

    async function importFromFile(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            const groups = Array.isArray(data?.groups) ? data.groups : [];
            if (!groups.length) {
                toastr.warning('文件里没有组');
                return;
            }
            let addedGroups = 0;
            let addedRules = 0;
            for (const g of groups) {
                const name = String(g?.name ?? '未命名');
                const rules = normalizeRules(g?.rules);
                let target = settings.groups.find((x) => x.name === name);
                if (!target) {
                    target = { id: genId(), name, enabled: g?.enabled !== false, rules: [] };
                    settings.groups.push(target);
                    addedGroups++;
                }
                const exists = new Set(target.rules.map((r) => r.find + '\u0000' + r.replace));
                for (const r of rules) {
                    const key = r.find + '\u0000' + r.replace;
                    if (exists.has(key)) continue;
                    target.rules.push({ find: r.find, replace: r.replace, enabled: r.enabled });
                    exists.add(key);
                    addedRules++;
                }
            }
            saveSettings();
            renderAll();
            toastr.success('导入完成：新增 ' + addedGroups + ' 个组、' + addedRules + ' 条规则');
        } catch (error) {
            console.error('[移花接木] 导入失败', error);
            toastr.error('导入失败：文件格式不对');
        }
    }

    actions.append(previewBtn, scanBtn, exportBtn, importBtn);
    const nameRow = $('<div class="yhjm-name-row"></div>');
    nameRow.append(groupName, addRule);
    const footer = $('<div class="yhjm-footer"></div>');
    footer.append(result, actions);
    left.append(searchRow, list);
    right.append(nameRow, rulesBox, footer);
    layout.append(left, right);
    container.append(layout);
    renderAll();

    const popup = new Popup(container, POPUP_TYPE.TEXT, '', {
        okButton: '关闭',
        allowVerticalScrolling: true,
    });
    void popup.show();
}

function addWandMenuEntry() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;
    if (document.getElementById('yhjm_menu_item')) return true;
    const item = $('<div id="yhjm_menu_item"><div class="fa-solid fa-shuffle extensionsMenuExtensionButton"></div><span>移花接木</span></div>');
    item.on('click', () => { openPanel(); });
    $(menu).append(item);
    return true;
}

jQuery(async () => {
    const tryAdd = (attempt = 0) => {
        if (addWandMenuEntry()) return;
        if (attempt < 40) setTimeout(() => tryAdd(attempt + 1), 250);
    };
    tryAdd();

    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => { void handleSingleMessage(messageId); });
    eventSource.on(event_types.MESSAGE_SWIPED, (messageId) => { void handleSingleMessage(messageId); });
});