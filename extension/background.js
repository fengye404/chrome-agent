const hostName = "com.chrome_agent.bridge";
const origins = new Set(["https://member.bilibili.com", "https://creator.douyin.com"]);
let session;

function disconnect(current) {
  if (session !== current) return;
  session = undefined;
  current.port?.disconnect();
  if (current.attached) chrome.debugger.detach({ tabId: current.tabId }).catch(() => {});
  chrome.action.setBadgeText({ tabId: current.tabId, text: "" }).catch(() => {});
}

function setBadge(tabId, text, color) {
  return Promise.all([
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color }),
  ]);
}

async function checkDocument(current) {
  const frame = await chrome.webNavigation.getFrame({ tabId: current.tabId, frameId: 0 });
  if (session !== current || frame?.documentId !== current.documentId ||
      new URL(frame.url).origin !== current.origin) {
    throw new Error("页面已变更，请重新点击扩展图标");
  }
}

// This function runs in an isolated world inside the selected document.
function editPage(action, selector, value) {
  if (action === "inspect") {
    const controls = Array.from(document.querySelectorAll("input, textarea, [contenteditable=true]"))
      .filter(el => el.type === "file" || (el.getClientRects().length && el.type !== "password"))
      .slice(0, 60)
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.type ?? "contenteditable",
        id: el.id,
        name: el.getAttribute("name"),
        placeholder: el.getAttribute("placeholder"),
        label: el.getAttribute("aria-label"),
        accept: el.getAttribute("accept"),
      }));
    return { title: document.title, origin: location.origin, path: location.pathname, controls };
  }

  const matches = document.querySelectorAll(selector);
  if (matches.length !== 1) throw new Error("选择器必须恰好匹配一个字段");
  const element = matches[0];
  if (!element.getClientRects().length || element.matches(":disabled,[readonly]")) {
    throw new Error("字段不可编辑");
  }

  const textInput = element instanceof HTMLInputElement &&
    ["text", "search"].includes(element.type);
  if (element instanceof HTMLTextAreaElement || textInput) {
    const prototype = textInput ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
  } else if (element.isContentEditable) {
    element.textContent = value;
  } else {
    throw new Error("请选择文本字段");
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { filled: true };
}

async function selectFile(current, selector, path) {
  const target = { tabId: current.tabId };
  if (!current.attached) {
    await chrome.debugger.attach(target, "1.3");
    if (session !== current) {
      await chrome.debugger.detach(target).catch(() => {});
      throw new Error("连接已断开");
    }
    current.attached = true;
  }

  const send = (method, params = {}) => chrome.debugger.sendCommand(target, method, params);
  const { frameTree } = await send("Page.getFrameTree");
  await checkDocument(current);
  const { executionContextId } = await send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id, worldName: "Chrome Agent file selector",
  });
  const expression = `(() => {
    if (location.origin !== ${JSON.stringify(current.origin)}) return null;
    const matches = document.querySelectorAll(${JSON.stringify(selector)});
    const input = matches[0];
    return matches.length === 1 && input instanceof HTMLInputElement &&
      input.type === "file" && !input.matches(":disabled") ? input : null;
  })()`;
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression, contextId: executionContextId, objectGroup: "chrome-agent-file",
  });
  try {
    if (exceptionDetails || !result.objectId) throw new Error("请选择一个可用的文件输入框");
    const { node } = await send("DOM.describeNode", { objectId: result.objectId });
    await checkDocument(current);
    await send("DOM.setFileInputFiles", { backendNodeId: node.backendNodeId, files: [path] });
    return { selected: true };
  } finally {
    await send("Runtime.releaseObjectGroup", { objectGroup: "chrome-agent-file" }).catch(() => {});
  }
}

async function handle(current, request) {
  await checkDocument(current);
  if (!["inspect", "fill", "select-file"].includes(request.action)) {
    throw new Error("不支持此命令");
  }
  if (request.action !== "inspect" &&
      (typeof request.selector !== "string" || !request.selector || request.selector.length > 512)) {
    throw new Error("需要有效的 CSS 选择器");
  }
  if (request.action === "select-file") {
    if (typeof request.path !== "string" || !request.path.startsWith("/") ||
        !/\.(mp4|mov|m4v|jpg|jpeg|png|webp)$/i.test(request.path)) {
      throw new Error("请选择受支持的本机视频或图片");
    }
    return selectFile(current, request.selector, request.path);
  }
  if (request.action === "fill" && (typeof request.value !== "string" || request.value.length > 20000)) {
    throw new Error("文本超过长度限制");
  }
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: current.tabId, documentIds: [current.documentId] },
    func: editPage,
    args: [request.action, request.selector ?? "", request.value ?? ""],
  });
  if (!result) throw new Error("页面操作未返回结果");
  return result;
}

chrome.action.onClicked.addListener(async tab => {
  if (session) {
    disconnect(session);
    return;
  }
  const current = { tabId: tab.id };
  session = current;
  try {
    const frame = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 });
    if (session !== current) return;
    const origin = new URL(frame.url).origin;
    if (!origins.has(origin)) throw new Error("请打开支持的投稿网站");
    current.origin = origin;
    current.documentId = frame.documentId;
    const port = chrome.runtime.connectNative(hostName);
    current.port = port;
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message;
      if (session !== current) return;
      disconnect(current);
      if (error) {
        console.error(error);
        setBadge(tab.id, "!", "#a12727").catch(() => {});
      }
    });
    port.onMessage.addListener(async request => {
      if (session !== current) return;
      if (request.ready === true) {
        await setBadge(tab.id, "ON", "#1b6b42");
        return;
      }
      let response;
      try {
        response = { ok: true, result: await handle(current, request) };
      } catch (error) {
        response = { ok: false, error: error.message };
      }
      if (session === current) port.postMessage(response);
    });
  } catch (error) {
    if (session !== current) return;
    disconnect(current);
    console.error(error.message);
    await setBadge(tab.id, "!", "#a12727");
  }
});

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, documentId }) => {
  if (frameId === 0 && session?.tabId === tabId && documentId !== session.documentId) {
    disconnect(session);
  }
});
chrome.tabs.onRemoved.addListener(tabId => {
  if (session?.tabId === tabId) disconnect(session);
});
chrome.debugger.onDetach.addListener(({ tabId }) => {
  if (session?.tabId === tabId && session.attached) disconnect(session);
});
