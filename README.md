# Chrome Agent

Chrome Agent 让本机代理协助填写 Chrome 中已打开的 B 站和抖音创作者页面。点击工具栏里的扩展图标后，命令行可以查看页面字段、填写标题和简介，以及为上传控件选择本机视频或封面。扩展一次连接一个标签页，使用现有登录状态。

## 安装

需要 macOS、Chrome 118 或更高版本，以及可用的 `/usr/bin/python3`。

```sh
git clone https://github.com/fengye404/chrome-agent.git
cd chrome-agent
python3 chrome_agent.py install
```

1. 在 Chrome 中打开 `chrome://extensions`，开启开发者模式。
2. 点「加载已解压的扩展程序」，选择仓库内的 `extension` 目录。
3. 打开 B 站或抖音的投稿页，点击工具栏里的 Chrome Agent 图标。徽标显示 `ON` 时，本机代理可以执行命令。

安装后请保留仓库路径，Chrome 按注册时的绝对路径启动连接器。图标出现 `!` 时，检查页面域名和扩展服务工作线程里的错误。Chrome 可能在选择文件时显示调试提示。

## 使用

在仓库内运行命令。先用 `inspect` 找字段，再根据实际页面替换示例选择器。

```sh
python3 chrome_agent.py inspect
python3 chrome_agent.py fill 'input#title' '每天醒来，我们还是昨天的自己吗？'
python3 chrome_agent.py fill 'textarea#description' '从一个关于记忆的脑洞聊起。'
python3 chrome_agent.py select-file 'input[type=file]' ~/Movies/episode.mp4
```

选择器必须唯一匹配。页面可能在选中文件后立即上传，发布仍由用户在网页上操作。再次点击扩展图标、关闭标签页或加载新文档都会断开连接。页面内的单页路由切换可以沿用连接。切换标签页时，先断开当前会话，再在新标签页点击图标。

## 权限和本机连接

- 扩展只在用户点击后操作 `member.bilibili.com` 或 `creator.douyin.com` 的顶层文档。
- `activeTab` 和 `scripting` 用于查看字段和填字。`webNavigation` 用于识别文档切换。`debugger` 用于选择文件。
- Native Messaging 使用绑定到此扩展 ID 的本机连接器。命令行通过当前 macOS 用户私有目录 `~/.chrome-agent/` 下的 Unix 套接字连接。能以同一 macOS 用户运行的程序可以使用当前会话。连接器只接受 `inspect`、`fill` 和 `select-file`。

卸载时先断开连接，在 `chrome://extensions` 移除扩展，然后运行 `python3 chrome_agent.py uninstall` 注销本机连接器。

## 验证

运行 `node tests/smoke.mjs`。测试使用独立的临时 Chrome 配置和模拟投稿页，覆盖本机连接、字段读取、标题简介填写、文件选择和断开。可通过 `CHROME_PATH` 指定支持扩展调试的 Chrome 可执行文件。
