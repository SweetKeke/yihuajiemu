import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    saveChat,
    saveChatDebounced,
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

const WILDCARD_STOP_CHARS = ',，。.!?！？；;\n';
const WILDCARD_PATTERN =
    '[^' +
    WILDCARD_STOP_CHARS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\n') +
    ']{0,15}?';

const MODE_OPTIONS = [
    { id: 'simple', label: '组合写法' },
    { id: 'text', label: '字面写法' },
];

/* ---------------- 数据层 ---------------- */

let idSeq = 0;
const genId = () => 'g' + Date.now().toString(36) + (idSeq++).toString(36);
let normalized = false;

/**
 * 统一规则结构：
 *   remark        备注
 *   targets       查找内容（每行一条）
 *   replacements  替换内容（每行一条，随机；空 = 删除）
 *   mode          simple | text
 */
function normalizeRule(raw) {
    const targets = Array.isArray(raw?.targets)
        ? raw.targets.map((s) => String(s)).map((s) => s.trim()).filter(Boolean)
        : raw?.find
            ? [String(raw.find)]
            : [];
    const replacements = Array.isArray(raw?.replacements)
        ? raw.replacements.map((s) => String(s))
        : raw?.replace
            ? [String(raw.replace)]
            : [];
    return {
        remark: String(raw?.remark ?? ''),
        targets,
        replacements,
        enabled: raw?.enabled !== false,
        mode: raw?.mode === 'text' ? 'text' : 'simple',
    };
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
            rules: (Array.isArray(g.rules) ? g.rules : []).map(normalizeRule).filter((r) => r.targets.length),
        }));
        if (!s.groups.length) {
            s.groups.push({
                id: genId(),
                name: DEFAULT_GROUP_NAME,
                enabled: true,
                rules: [
                    normalizeRule({
                        remark: '示例规则（默认停用）',
                        targets: ['{突然,猛地}{一顿,一颤}?'],
                        replacements: [],
                        enabled: false,
                    }),
                ],
            });
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
            if (rule.enabled && rule.targets.length) out.push(rule);
        }
    }
    return out;
}

function saveSettings() {
    saveSettingsDebounced();
}

/* ---------------- 简易语法 ---------------- */

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 顶层按 | 或 , 切分（不切花括号内部） */
function splitTopLevel(text) {
    const parts = [];
    let depth = 0;
    let buffer = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\' && i + 1 < text.length) {
            buffer += ch + text[i + 1];
            i++;
            continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') depth = Math.max(0, depth - 1);
        if ((ch === '|' || ch === ',') && depth === 0) {
            parts.push(buffer);
            buffer = '';
        } else {
            buffer += ch;
        }
    }
    parts.push(buffer);
    return parts;
}

/** 字面模式：按逗号拆多条，支持 \, 转义，并还原转义字符 */
function splitLiteralList(text) {
    const out = [];
    let buffer = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\' && i + 1 < text.length) {
            buffer += text[i + 1];
            i++;
            continue;
        }
        if (ch === ',' || ch === '，') {
            out.push(buffer);
            buffer = '';
        } else {
            buffer += ch;
        }
    }
    out.push(buffer);
    return out.map((s) => s.trim()).filter(Boolean);
}

/** 编译单条分支：{a,b} → (?:a|b)，}? → 可选，其余转义 */
function compileBranch(branch) {
    let out = '';
    let pending = '';
    const flush = () => {
        if (pending) {
            out += escapeRegExp(pending);
            pending = '';
        }
    };
    let i = 0;
    while (i < branch.length) {
        const ch = branch[i];
        if (ch === '\\' && i + 1 < branch.length) {
            flush();
            out += escapeRegExp(branch[i + 1]);
            i += 2;
            continue;
        }
        if (ch === '*') {
            flush();
            out += WILDCARD_PATTERN;
            i++;
            continue;
        }
        if (ch === '{') {
            flush();
            const close = branch.indexOf('}', i);
            if (close === -1) {
                pending += branch.slice(i);
                break;
            }
            const options = branch
                .slice(i + 1, close)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
                .map(escapeRegExp);
            if (options.length) {
                out += '(?:' + options.join('|') + ')';
                if (branch[close + 1] === '?') {
                    out += '?';
                    i = close + 2;
                    continue;
                }
            }
            i = close + 1;
            continue;
        }
        if (ch === '?') {
            if (pending) {
                const last = pending.slice(-1);
                pending = pending.slice(0, -1);
                flush();
                out += escapeRegExp(last) + '?';
            } else {
                pending += ch;
            }
            i++;
            continue;
        }
        pending += ch;
        i++;
    }
    flush();
    return out;
}

function compileFind(find, mode = 'simple') {
    if (mode === 'text') return { find, re: null };
    if (!find.includes('{') && !find.includes('|') && !find.includes('?') && !find.includes(',') && !find.includes('*')) {
        return { find, re: null };
    }
    const branches = splitTopLevel(find)
        .map((branch) => branch.trim())
        .map(compileBranch)
        .filter(Boolean);
    if (!branches.length) return { find, re: null };
    return { find, re: new RegExp(branches.join('|'), 'g') };
}

const matcherCache = new Map();

function getMatcher(find, mode) {
    const key = String(mode ?? 'simple') + '\u0000' + find;
    const cached = matcherCache.get(key);
    if (cached) return cached;
    // 规则改多了会不断新增缓存，超过上限就整体清一次
    if (matcherCache.size > 500) matcherCache.clear();
    const matcher = compileFind(find, mode);
    matcherCache.set(key, matcher);
    return matcher;
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

function pickReplacement(list) {
    if (!Array.isArray(list) || !list.length) return '';
    return list[Math.floor(Math.random() * list.length)];
}

function replacePlain(text, find, replacements) {
    let out = '';
    let index = 0;
    while (true) {
        const pos = text.indexOf(find, index);
        if (pos === -1) {
            out += text.slice(index);
            break;
        }
        out += text.slice(index, pos) + pickReplacement(replacements);
        index = pos + find.length;
    }
    return out;
}

function applyRulesToText(text, rules) {
    if (typeof text !== 'string' || !text) return text;
    let out = text;
    for (const rule of rules) {
        for (const target of rule.targets) {
            const matcher = getMatcher(target, rule.mode);
            if (matcher.re) {
                out = out.replace(matcher.re, () => pickReplacement(rule.replacements));
            } else if (out.includes(target)) {
                out = replacePlain(out, target, rule.replacements);
            }
        }
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

function countInText(text, target, mode) {
    const matcher = getMatcher(target, mode);
    if (matcher.re) {
        const found = text.match(matcher.re);
        return found ? found.length : 0;
    }
    return countOccurrences(text, target);
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
                for (const target of rule.targets) {
                    const found = countInText(text, target, rule.mode);
                    if (found > 0) {
                        changed = true;
                        hits += found;
                    }
                }
            }
        }
        if (changed) messages++;
    }
    return { messages, hits };
}

/* ---------------- 消息处理 ---------------- */

let busy = false;

function handleSingleMessage(messageId) {
    try {
        const id = Number(messageId);
        if (!Number.isInteger(id) || id < 0) return;
        const rules = getEnabledRules();
        if (!rules.length) return;
        const msg = getContext().chat?.[id];
        if (!msg) return;
        if (!applyToMessage(msg, rules)) return;
        saveChatDebounced();
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
            version: 2,
            exportedAt: new Date().toISOString(),
            groups: settings.groups.map((g) => ({
                name: g.name,
                enabled: g.enabled,
                rules: g.rules.map((r) => ({
                    remark: r.remark,
                    targets: r.targets,
                    replacements: r.replacements,
                    enabled: r.enabled,
                    mode: r.mode,
                })),
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
        let groups = Array.isArray(data?.groups) ? data.groups : [];
        if (!groups.length && Array.isArray(data?.rules)) {
            groups = data.rules.map((item) => ({
                name: String(item?.name ?? UNNAMED_GROUP),
                enabled: item?.enabled !== false,
                rules: (Array.isArray(item?.subRules) ? item.subRules : []).map((sub) => ({
                    remark: String(sub?.remark ?? ''),
                    targets: Array.isArray(sub?.targets) ? sub.targets : [],
                    replacements: Array.isArray(sub?.replacements) ? sub.replacements : [],
                    enabled: sub?.enabled !== false,
                    mode: sub?.mode === 'text' ? 'text' : 'simple',
                })),
            }));
        }
        if (!groups.length) return { ok: false, message: '文件里没有组' };

        const settings = getSettings();
        let addedGroups = 0;
        let addedRules = 0;
        for (const g of groups) {
            const name = String(g?.name ?? UNNAMED_GROUP);
            let target = settings.groups.find((x) => x.name === name);
            if (!target) {
                target = { id: genId(), name, enabled: g?.enabled !== false, rules: [] };
                settings.groups.push(target);
                addedGroups++;
            }
            const exists = new Set(target.rules.map((r) => r.targets.join('\u0000') + '\u0001' + r.replacements.join('\u0000')));
            for (const rawRule of Array.isArray(g?.rules) ? g.rules : []) {
                const rule = normalizeRule(rawRule);
                if (!rule.targets.length) continue;
                const key = rule.targets.join('\u0000') + '\u0001' + rule.replacements.join('\u0000');
                if (exists.has(key)) continue;
                target.rules.push(rule);
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

/* ---------------- 弹窗 ---------------- */

function editorLabel(text) {
    return $('<div class="yhjm-editor-label"></div>').text(text);
}

function openNewGroupDialog() {
    return new Promise((resolve) => {
        const box = $('<div class="yhjm-rule-editor"></div>');
        const name = $('<input class="text_pole" type="text" placeholder="组名">').val(nextGroupName());
        box.append(editorLabel('新组名'), name);
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

function openRuleEditor(rule) {
    return new Promise((resolve) => {
        const box = $('<div class="yhjm-rule-editor"></div>');

        const modeSelect = $('<select class="text_pole"></select>');
        for (const item of MODE_OPTIONS) {
            modeSelect.append($('<option></option>').val(item.id).text(item.label));
        }
        modeSelect.val(rule?.mode ?? 'simple');

        const remark = $('<input class="text_pole" type="text" placeholder="随便记一笔，比如：清理口头禅">')
            .val(rule?.remark ?? '');
        const targets = $('<textarea class="text_pole yhjm-textarea" rows="4"></textarea>')
            .val((rule?.targets ?? []).join('\n'));
        const replacements = $('<textarea class="text_pole yhjm-textarea" rows="4"></textarea>')
            .attr('placeholder', '一行一条，也可用逗号分隔；命中后随机挑一条换上去，不填就直接删掉')
            .val((rule?.replacements ?? []).join('\n'));

        const syncPlaceholder = () => {
            targets.attr(
                'placeholder',
                modeSelect.val() === 'text'
                    ? '一行一条，也可用逗号分隔\n比如：他叹了口气,她笑了笑'
                    : '一行一条，可用 {甲,乙} 任选、| 表示或、? 表示可省略\n比如：{突然,猛地}{一顿,一颤}?',
            );
        };
        modeSelect.on('change', syncPlaceholder);
        syncPlaceholder();

        box.append(
            editorLabel('备注（可选）'), remark,
            editorLabel('匹配方式'), modeSelect,
            editorLabel('查找'), targets,
            editorLabel('替换'), replacements,
        );

        const popup = new Popup(box, POPUP_TYPE.CONFIRM, '', {
            okButton: '保存',
            cancelButton: '取消',
        });
        popup.show().then((result) => {
            if (result !== POPUP_RESULT.AFFIRMATIVE) {
                resolve(null);
                return;
            }
            const isTextMode = String(modeSelect.val()) === 'text';
            const targetList = String(targets.val())
                .split('\n')
                .flatMap((line) => {
                    const text = line.trim();
                    if (!text) return [];
                    if (!isTextMode) return [text];
                    return splitLiteralList(text);
                })
                .filter(Boolean);
            if (!targetList.length) {
                toastr.warning('查找不能为空');
                resolve(null);
                return;
            }
            const replacementList = String(replacements.val())
                .split('\n')
                .flatMap((line) => splitLiteralList(line));
            resolve({
                remark: String(remark.val()),
                targets: targetList,
                replacements: replacementList,
                enabled: rule?.enabled !== false,
                mode: String(modeSelect.val()),
            });
        });
    });
}

/* ---------------- DOM ---------------- */

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
    const addRule = makeIconButton('新建规则', 'fa-plus');
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

    function renderRules() {
        const group = selectedGroup();
        dom.rulesBox.empty();
        if (!group) return;
        for (const rule of group.rules) {
            dom.rulesBox.append(renderRuleRow(rule));
        }
        if (!group.rules.length) {
            dom.rulesBox.append($('<p class="yhjm-empty"></p>').text('这个组还没有规则，点右上角的 ＋ 新建。'));
        }
    }

    function renderRuleRow(rule) {
        const row = $('<div class="yhjm-rule"></div>');

        const enable = $('<input type="checkbox" class="yhjm-enabled" title="启用这条规则">')
            .prop('checked', rule.enabled);
        enable.on('change', () => {
            rule.enabled = enable.prop('checked');
            saveSettings();
        });

        const name = $('<span class="yhjm-rule-name"></span>')
            .text(rule.remark || rule.targets[0] || '(未命名)');
        if (rule.targets.length > 1) {
            name.append($('<span class="yhjm-rule-count"></span>').text(' +' + (rule.targets.length - 1)));
        }

        const target = $('<span class="yhjm-rule-target"></span>')
            .text(rule.replacements.length ? rule.replacements.join(' / ') : '删除');

        const text = $('<div class="yhjm-rule-text"></div>');
        text.append(name, $('<span class="yhjm-arrow">→</span>'), target);
        text.on('click', () => { void editRule(rule); });

        const del = makeIconButton('删除这条规则', 'fa-trash');
        del.on('click', () => {
            const group = selectedGroup();
            if (!group) return;
            group.rules = group.rules.filter((r) => r !== rule);
            saveSettings();
            renderRules();
        });

        row.append(enable, text, del);
        return row;
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
        let cancelled = false;
        const commit = () => {
            if (cancelled) return;
            group.name = String(input.val()).trim() || UNNAMED_GROUP;
            saveSettings();
            renderAll();
        };
        input.on('blur', commit);
        input.on('keydown', (ev) => {
            if (ev.key === 'Enter') input.trigger('blur');
            if (ev.key === 'Escape') {
                cancelled = true;
                renderAll();
            }
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

    async function createRule() {
        const group = selectedGroup();
        if (!group) return;
        const rule = await openRuleEditor(null);
        if (!rule) return;
        group.rules.push(rule);
        saveSettings();
        renderRules();
    }

    async function editRule(rule) {
        const edited = await openRuleEditor(rule);
        if (!edited) return;
        rule.remark = edited.remark;
        rule.targets = edited.targets;
        rule.replacements = edited.replacements;
        rule.mode = edited.mode;
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
        dom.addRule.on('click', () => { void createRule(); });
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

    // AI 回复
    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => { handleSingleMessage(messageId); });
    // 切换刷新
    eventSource.on(event_types.MESSAGE_SWIPED, (messageId) => { handleSingleMessage(messageId); });
    // 用户发送的消息（在 prompt 组装前改掉，AI 看不到原词）
    eventSource.on(event_types.MESSAGE_SENT, (messageId) => { handleSingleMessage(messageId); });
});