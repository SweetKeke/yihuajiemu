# 移花接木

一个轻量的 SillyTavern 扩展：按规则**永久**替换聊天内容中的关键词。

替换直接写入聊天数据并保存，关闭扩展或重启 SillyTavern 后不会还原。

## 功能

- 支持多组规则，可单独启用或停用
- 新消息与重新生成的回复会自动替换并保存
- 可一键扫描当前聊天，修复已有消息
- 支持规则的导入与导出（JSON）
- 无定时轮询，开销极小

## 安装

### 通过 GitHub 安装

1. 打开 SillyTavern，进入 **扩展 → 安装扩展**
2. 填入仓库地址：

   ```
   https://github.com/SweetKeke/yihuajiemu
   ```

3. 安装完成后刷新页面，在扩展列表中启用「移花接木」

### 手动安装

将本仓库放入 SillyTavern 的扩展目录之一：

```
public/scripts/extensions/third-party/yihuajiemu
data/default-user/extensions/yihuajiemu
```

重启 SillyTavern 后启用。

## 使用

打开顶部魔法棒菜单，点击「移花接木」。

- 左侧为规则组，可新建、启用/停用、删除
- 右侧为当前组的规则，每条规则形如 `查找 → 替换`
- 「替换」留空表示删除该词
- 点击规则行可展开编辑，也可直接修改

## 说明

- 仅处理消息正文与备选回复
- 不处理世界书、角色卡、预设等数据
- 规则为纯文本替换，不支持正则

## 协议

MIT