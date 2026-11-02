import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    saveChat,
    updateMessageBlock,
    printMessages,
    eventSource,
    event_types,
} from '../../../../script.js';
import { Popup, POPUP_TYPE } from '../../../popup.js';

const EXT_NAME = 'yihuajiemu';

let idSeq = 0;
const genId = () => 'g' + Date.now().toString(36) + (idSeq++).toString(36);

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

function renderRuleRow(rule, onChange, onDelete) {
    const row = $('<div class="yhjm-rule"></div>');
    const find = $('<input class="text_pole yhjm-find" type="text" placeholder="查找">').val(rule.find);
    const arrow = $('<span class="yhjm-arrow">→</span>');
    const replace = $('<input class="text_pole yhjm-replace" type="text" placeholder="替换（留空 = 删除）">').val(rule.replace);
    const enabled = $('<input type="checkbox" class="yhjm-enabled">').prop('checked', rule.enabled);
    const label = $('<label class="yhjm-enable-label"></label>').append(enabled).append(' 启用');
    const del = $('<button class="menu_button yhjm-icon-btn" title="删除这条规则"></button>').append('<i class="fa-solid fa-trash"></i>');

    find.on('input', () => { rule.find = String(find.val()).trim(); onChange(); });
    replace.on('input', () => { rule.replace = String(replace.val()); onChange(); });
    enabled.on('change', () => { rule.enabled = enabled.prop('checked'); onChange(); });
    del.on('click', onDelete);

    row.append(find, arrow, replace, label, del);
    return row;
}

function openPanel() {
    const settings = getSettings();
    const container = $('<div class="yhjm-panel"></div>');
    const layout = $('<div class="yhjm-layout"></div>');
    const left = $('<div class="yhjm-left"></div>');
    const right = $('<div class="yhjm-right"></div>');
    const search = $('<input class="text_pole yhjm-search" type="text" placeholder="搜索组…">');
    const list = $('<div class="yhjm-group-list"></div>');
    const addGroup = $('<button class="menu_button yhjm-add-group"></button>').append('<i class="fa-solid fa-plus"></i> ').append('新建组');
    const groupName = $('<input class="text_pole yhjm-group-name" type="text" placeholder="组名">');
    const rulesBox = $('<div class="yhjm-rules"></div>');
    const actions = $('<div class="yhjm-actions"></div>');
    const result = $('<div class="yhjm-result"></div>');

    let selectedId = settings.activeGroupId;
    let filter = '';

    const selectedGroup = () => settings.groups.find((g) => g.id === selectedId) ?? settings.groups[0] ?? null;

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

            const enable = $('<input type="checkbox" class="yhjm-group-enable">').prop('checked', group.enabled);
            enable.on('click', (event) => event.stopPropagation());
            enable.on('change', () => { group.enabled = enable.prop('checked'); saveSettings(); });

            const name = $('<span class="yhjm-group-item-name"></span>').text(group.name || '未命名');
            name.on('click', () => {
                selectedId = group.id;
                settings.activeGroupId = group.id;
                saveSettings();
                renderAll();
            });

            const del = $('<button class="yhjm-group-del menu_button yhjm-icon-btn" title="删除这个组"></button>').append('<i class="fa-solid fa-trash"></i>');
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

            row.append(name, del, enable);
            list.append(row);
        }
    }

    function renderRight() {
        const group = selectedGroup();
        if (!group) return;
        groupName.val(group.name);
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

    addGroup.on('click', () => {
        const group = { id: genId(), name: '组' + (settings.groups.length + 1), enabled: true, rules: [] };
        settings.groups.push(group);
        selectedId = group.id;
        settings.activeGroupId = group.id;
        saveSettings();
        renderAll();
    });

    groupName.on('input', () => {
        const group = selectedGroup();
        if (!group) return;
        group.name = String(groupName.val());
        saveSettings();
        renderList();
    });

    const addRule = $('<button class="menu_button"></button>').append('<i class="fa-solid fa-plus"></i> ').append('添加规则');
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
        if (!rules.length) { result.text('没有启用的规则（看看左边哪些组没勾）。'); return; }
        const { messages, hits } = countMatches(getContext().chat ?? [], rules);
        result.text(messages ? '当前聊天会改到 ' + messages + ' 条消息、共 ' + hits + ' 处。' : '当前聊天没有命中任何规则。');
    });

    const scanBtn = $('<button class="menu_button"></button>').text('扫描当前聊天');
    scanBtn.on('click', async () => {
        const changed = await scanCurrentChat();
        result.text(changed ? '已永久替换 ' + changed + ' 条消息。' : '没有需要替换的内容。');
    });

    actions.append(addRule, previewBtn, scanBtn);
    left.append(search, list, addGroup);
    right.append(groupName, rulesBox, actions, result);
    layout.append(left, right);
    container.append(layout);
    renderAll();

    const popup = new Popup(container, POPUP_TYPE.TEXT, '', {
        okButton: '关闭',
        wider: true,
        allowVerticalScrolling: true,
    });
    if (popup.dlg) popup.dlg.classList.add('yhjm-dialog');
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