import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    saveChat,
    updateMessageBlock,
    printMessages,
    eventSource,
    event_types,
} from '../../../../script.js';

const EXT_NAME = 'yihuajiemu';

// 默认给一个示例，用户可以在设置里改成自己的规则。
const DEFAULT_RULES = '# 每行一条：查找=>替换（右侧留空=删除该词）\n嫉妒=>忌度';

function getSettings() {
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = { rules: DEFAULT_RULES };
    }
    return extension_settings[EXT_NAME];
}

function parseRules() {
    const raw = String(getSettings().rules ?? '');
    const rules = [];
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=>');
        if (idx === -1) {
            rules.push({ find: trimmed, replace: '' });
            continue;
        }
        const find = trimmed.slice(0, idx).trim();
        const replace = trimmed.slice(idx + 2).trim();
        if (find) rules.push({ find, replace });
    }
    return rules;
}

function applyRulesToText(text, rules) {
    if (typeof text !== 'string' || !text) return text;
    let out = text;
    for (const rule of rules) {
        if (out.includes(rule.find)) {
            out = out.split(rule.find).join(rule.replace);
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

let busy = false;

async function handleSingleMessage(messageId) {
    try {
        if (busy) return;
        const id = Number(messageId);
        if (!Number.isInteger(id) || id < 0) return;
        const rules = parseRules();
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
    if (busy) return;
    const rules = parseRules();
    if (!rules.length) {
        toastr.warning('还没有设置替换规则');
        return;
    }
    const chatArr = getContext().chat;
    if (!Array.isArray(chatArr) || chatArr.length === 0) {
        toastr.warning('当前聊天是空的');
        return;
    }
    let changed = 0;
    for (const msg of chatArr) {
        if (applyToMessage(msg, rules)) changed++;
    }
    if (changed === 0) {
        toastr.info('当前聊天没有需要替换的内容');
        return;
    }
    busy = true;
    try {
        await saveChat();
        await printMessages();
        toastr.success('已永久替换 ' + changed + ' 条消息');
    } catch (error) {
        console.error('[移花接木] 扫描聊天失败', error);
        toastr.error('替换失败，请查看控制台');
    } finally {
        busy = false;
    }
}

jQuery(async () => {
    const html = `
    <div class="yihuajiemu-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>移花接木</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <label for="yhjm-rules">规则（每行一条，格式 <code>查找=&gt;替换</code>，右侧留空=删除；# 开头为注释）</label>
          <textarea id="yhjm-rules" class="text_pole" rows="8"></textarea>
          <button id="yhjm-scan" class="menu_button">扫描当前聊天（修复已有消息）</button>
          <p><small>新收到 / 新刷新的消息会自动按规则<b>永久替换并保存</b>；已有消息点上面的按钮批量扫描。关掉本扩展也不会变回去。</small></p>
        </div>
      </div>
    </div>`;

    $('#extensions_settings2').append(html);

    $('#yhjm-rules')
        .val(getSettings().rules)
        .on('input', () => {
            getSettings().rules = String($('#yhjm-rules').val());
            saveSettingsDebounced();
        });

    $('#yhjm-scan').on('click', () => { void scanCurrentChat(); });

    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => { void handleSingleMessage(messageId); });
    eventSource.on(event_types.MESSAGE_SWIPED, (messageId) => { void handleSingleMessage(messageId); });
});