import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    saveChat,
    printMessages,
    eventSource,
    event_types,
} from '../../../../script.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';

/* ---------------- 常量 ---------------- */

const EXT_NAME = 'yihuajiemu';
const DEFAULT_GROUP_NAME = '默认';
const GROUP_NAME_PREFIX = '组';
const UNNAMED_GROUP = '未命名';

/* ---------------- 数据层 ---------------- */

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

function getSettings() {
    if (!extension_settings[EXT_NAME]) extension_settings[EXT_NAME] = {};
    const s = extension_settings[EXT_NAME];
    if (!normalized) {
        if (!Array.isArray(s.groups)) s.groups = [];
        s.groups = s.groups.map((g) => ({
            id: g.id ?? genId(),
            name: String(g.name ?? UNNAMED_GROUP),
            enabled: g.enabled !== false,
            rules: normalizeRules(g.rules),
        }));
        if (!s.groups.length) {
            s.groups.push({ id: genId(), name: DEFAULT_GROUP_NAME, enabled: true, rules: [] });
        }
        if (!s.activeGroupId || !s.groups.some((g) => g.id === s.activeGroupId)) {
            s.activeGroupId = s.groups[0].id;
        }
        normalized = true;
    }
    return s;
}

function nextGroupName() {
    return GROUP_NAME_PREFIX + (getSettings().groups.length + 1);
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

/* ---------------- 文本处理 ---------------- */

function countOccurrences(text, find) {
    if (!find) return 0;
    let count = 0;
    let index = text.indexOf(find);
    while (index !== -1) {
        count++;
        index = text.indexOf(find, index + find.length);
    }
    return count;
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
        if (next !== msg.mes) {
            msg.mes = next;
            changed = true;
        }
    }
    if (Array.isArray(msg?.swipes)) {
        for (let i = 0; i < msg.swipes.length; i++) {
            if (typeof msg.swipes[i] !== 'string') continue;
            const next = applyRulesToText(msg.swipes[i], rules);
            if (next !== msg.swipes[i]) {
                msg.swipes[i] = next;
                changed = true;
            }
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
                const found = countOccurrences(text, rule.find);
                if (found > 0) {
                    changed = true;
                    hits += found;
                }
            }
        }
        if (changed) messages++;
    }
    return { messages, hits };
}

/* ---------------- 消息处理 ---------------- */

let busy = false;

async function handleSingleMessage(messageId) {
    try {
        if (busy) {
            setTimeout(() => { void handleSingleMessage(messageId); }, 500);
            return;
        }
        const id = Number(messageId);
        if (!Number.isInteger(id) || id < 0) return;
        const rules = getEnabledRules();
        if (!rules.length) return;
        const msg = getContext().chat?.[id];
        if (!msg) return;
        if (!applyToMessage(msg, rules)) return;
        busy = true;
        try {
            await saveChat();
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

/* ---------------- 导入 / 导出 ---------------- */

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

async function importFromFile(file) {
    try {
        const data = JSON.parse(await file.text());
        const groups = Array.isArray(data?.groups) ? data.groups : [];
        if (!groups.length) return { ok: false, message: '文件里没有组' };

        const settings = getSettings();
        let addedGroups = 0;
        let addedRules = 0;
        for (const g of groups) {
            const name = String(g?.name ?? UNNAMED_GROUP);
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
        return { ok: true, addedGroups, addedRules };
    } catch (error) {
        console.error('[移花接木] 导入失败', error);
        return { ok: false, message: '文件格式不对' };
    }
}

/* ---------------- 弹窗：新建组 ---------------- */

function openNewGroupDialog() {
    return new Promise((resolve) => {
        const box = $('<div class="yhjm-rule-editor"></div>');
        const name = $('<input class="text_pole" type="text" placeholder="组名">').val(nextGroupName());
        box.append($('<label class="yhjm-editor-label"></label>').text('新组名'), name);
        const popup = new Popup(box, POPUP_TYPE.CONFIRM, '', {
            okButton: '创建',
            cancelButton: '取消',
        });
        popup.show().then((result) => {
            if (result !== POPUP_RESULT.AFFIRMATIVE) {
                resolve(null);
                return;
            }
            resolve(String(name.val()).trim() || nextGroupName());
        });
    });
}

/* ---------------- DOM 构建 ---------------- */

function makeIconButton(title, iconClass) {
    return $('<button class="menu_button yhjm-icon-btn"></button>')
        .attr('title', title)
        .append('<i class="fa-solid ' + iconClass + '"></i>');
}

function makeTextButton(label) {
    return $('<button class="menu_button"></button>').text(label);
}

function buildPanelDom() {
    const panel = $('<div class="yhjm-panel"></div>');
    const layout = $('<div class="yhjm-layout"></div>');
    const left = $('<div class="yhjm-left"></div>');
    const right = $('<div class="yhjm-right"></div>');

    const searchRow = $('<div class="yhjm-search-row"></div>');
    const search = $('<input class="text_pole yhjm-search" type="text" placeholder="搜索组…">');
    const addGroup = makeIconButton('新建组', 'fa-plus');
    searchRow.append(search, addGroup);

    const list = $('<div class="yhjm-group-list"></div>');

    const nameRow = $('<div class="yhjm-name-row"></div>');
    const groupName = $('<input class="text_pole yhjm-group-name" type="text" placeholder="组名">');
    const addRule = makeIconButton('添加规则', 'fa-plus');
    nameRow.append(groupName, addRule);

    const rulesBox = $('<div class="yhjm-rules"></div>');

    const footer = $('<div class="yhjm-footer"></div>');
    const result = $('<div class="yhjm-result"></div>');
    const actions = $('<div class="yhjm-actions"></div>');
    const previewBtn = makeTextButton('预览');
    const scanBtn = makeTextButton('扫描当前聊天');
    const exportBtn = makeTextButton('导出');
    const importBtn = makeTextButton('导入');
    actions.append(previewBtn, scanBtn, exportBtn, importBtn);
    footer.append(result, actions);

    const fileInput = $('<input type="file" accept=".json,application/json" style="display:none">');

    left.append(searchRow, list);
    right.append(nameRow, rulesBox, footer);
    layout.append(left, right);
    panel.append(layout, fileInput);

    return {
        panel, search, addGroup, list, groupName, addRule,
        rulesBox, result, previewBtn, scanBtn, exportBtn, importBtn, fileInput,
    };
}

/* ---------------- 面板控制器 ---------------- */

function createPanelController() {
    const settings = getSettings();
    const dom = buildPanelDom();

    let selectedId = settings.activeGroupId;
    let filter = '';

    const selectedGroup = () =>
        settings.groups.find((g) => g.id === selectedId) ?? settings.groups[0] ?? null;

    function renderRuleRow(rule) {
        const row = $('<div class="yhjm-rule"></div>');
        const find = $('<input class="text_pole yhjm-find" type="text" placeholder="查找">').val(rule.find);
        const arrow = $('<span class="yhjm-arrow">→</span>');
        const replace = $('<input class="text_pole yhjm-replace" type="text" placeholder="替换（留空 = 删除）">').val(rule.replace);
        const enabled = $('<input type="checkbox" class="yhjm-enabled" title="启用">').prop('checked', rule.enabled);
        const del = makeIconButton('删除这条规则', 'fa-trash');

        find.on('input', () => {
            rule.find = String(find.val()).trim();
            saveSettings();
        });
        replace.on('input', () => {
            rule.replace = String(replace.val());
            saveSettings();
        });
        enabled.on('change', () => {
            rule.enabled = enabled.prop('checked');
            saveSettings();
        });
        del.on('click', () => {
            const group = selectedGroup();
            if (!group) return;
            group.rules = group.rules.filter((r) => r !== rule);
            saveSettings();
            renderRules();
        });

        row.append(find, arrow, replace, enabled, del);
        return row;
    }

    function renderRules() {
        const group = selectedGroup();
        dom.rulesBox.empty();
        if (!group) return;
        for (const rule of group.rules) {
            dom.rulesBox.append(renderRuleRow(rule));
        }
        if (!group.rules.length) {
            dom.rulesBox.append($('<p class="yhjm-empty"></p>').text('这个组还没有规则。'));
        }
    }

    function renderGroupList() {
        dom.list.empty();
        const groups = filter
            ? settings.groups.filter((g) => (g.name || '').toLowerCase().includes(filter.toLowerCase()))
            : settings.groups;

        if (!groups.length) {
            dom.list.append($('<p class="yhjm-empty"></p>').text('没有匹配的组'));
            return;
        }

        for (const group of groups) {
            const row = $('<div class="yhjm-group-item"></div>');
            if (group.id === selectedId) row.addClass('active');

            const name = $('<span class="yhjm-group-item-name"></span>').text(group.name || UNNAMED_GROUP);
            name.on('click', () => selectGroup(group.id));
            name.on('dblclick', (event) => renameGroup(event, group, name));

            const enable = $('<input type="checkbox" class="yhjm-group-enable" title="启用这个组">')
                .prop('checked', group.enabled);
            enable.on('change', () => {
                group.enabled = enable.prop('checked');
                saveSettings();
            });

            const del = makeIconButton('删除这个组', 'fa-trash');
            del.addClass('yhjm-group-del');
            del.on('click', (event) => {
                event.stopPropagation();
                removeGroup(group);
            });

            row.append(name, enable, del);
            dom.list.append(row);
        }
    }

    function renderGroupName() {
        const group = selectedGroup();
        dom.groupName.val(group ? group.name : '');
    }

    function renderAll() {
        renderGroupList();
        renderGroupName();
        renderRules();
    }

    function selectGroup(id) {
        selectedId = id;
        settings.activeGroupId = id;
        saveSettings();
        renderAll();
    }

    function renameGroup(event, group, nameNode) {
        event.stopPropagation();
        const input = $('<input class="text_pole yhjm-rename" type="text">').val(group.name);
        nameNode.replaceWith(input);
        input.trigger('focus').select?.();
        const commit = () => {
            group.name = String(input.val()).trim() || UNNAMED_GROUP;
            saveSettings();
            renderAll();
        };
        input.on('blur', commit);
        input.on('keydown', (ev) => {
            if (ev.key === 'Enter') input.trigger('blur');
            if (ev.key === 'Escape') renderAll();
        });
    }

    function removeGroup(group) {
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
    }

    async function createGroup() {
        const name = await openNewGroupDialog();
        if (!name) return;
        const group = { id: genId(), name, enabled: true, rules: [] };
        settings.groups.push(group);
        selectGroup(group.id);
    }

    function addRule() {
        const group = selectedGroup();
        if (!group) return;
        group.rules.push({ find: '', replace: '', enabled: true });
        saveSettings();
        renderRules();
    }

    function preview() {
        const rules = getEnabledRules();
        if (!rules.length) {
            dom.result.text('没有启用的规则。');
            return;
        }
        const { messages, hits } = countMatches(getContext().chat ?? [], rules);
        dom.result.text(
            messages
                ? '当前聊天会改到 ' + messages + ' 条消息、共 ' + hits + ' 处。'
                : '当前聊天没有命中任何规则。',
        );
    }

    async function scan() {
        const changed = await scanCurrentChat();
        dom.result.text(changed ? '已永久替换 ' + changed + ' 条消息。' : '没有需要替换的内容。');
    }

    async function doImport(file) {
        const res = await importFromFile(file);
        if (!res.ok) {
            toastr.warning(res.message);
            return;
        }
        renderAll();
        toastr.success('导入完成：新增 ' + res.addedGroups + ' 个组、' + res.addedRules + ' 条规则');
    }

    function bindEvents() {
        dom.search.on('input', () => {
            filter = String(dom.search.val());
            renderGroupList();
        });
        dom.addGroup.on('click', () => { void createGroup(); });
        dom.addRule.on('click', addRule);
        dom.groupName.on('input', () => {
            const group = selectedGroup();
            if (!group) return;
            group.name = String(dom.groupName.val());
            saveSettings();
            renderGroupList();
        });
        dom.previewBtn.on('click', preview);
        dom.scanBtn.on('click', () => { void scan(); });
        dom.exportBtn.on('click', exportRules);
        dom.importBtn.on('click', () => dom.fileInput.trigger('click'));
        dom.fileInput.on('change', () => {
            const file = dom.fileInput[0]?.files?.[0];
            if (file) void doImport(file);
            dom.fileInput.val('');
        });
    }

    bindEvents();
    renderAll();

    return { container: dom.panel };
}

/* ---------------- 入口 ---------------- */

function openPanel() {
    const { container } = createPanelController();
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
        if (attempt < 120) setTimeout(() => tryAdd(attempt + 1), 250);
    };
    tryAdd();

    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => { void handleSingleMessage(messageId); });
    eventSource.on(event_types.MESSAGE_SWIPED, (messageId) => { void handleSingleMessage(messageId); });
});