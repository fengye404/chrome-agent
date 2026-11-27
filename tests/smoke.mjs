import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const tmp = mkdtempSync("/tmp/chrome-agent-test-");
const profile = path.join(tmp, "profile");
const manifestDir = path.join(profile, "NativeMessagingHosts");
mkdirSync(manifestDir, { recursive: true });
const python = (code) => execFileSync("/usr/bin/python3", ["-c", code], { encoding: "utf8" }).trim();
const config = JSON.parse(python("import json, chrome_agent as c; print(json.dumps(c.host_config()))"));
const launcher = path.join(tmp, "host");
writeFileSync(launcher, `#!/bin/sh\nexport HOME='${tmp}'\nexec "${root}/native-host" "$@"\n`, { mode: 0o700 });
writeFileSync(path.join(manifestDir, config.name + ".json"), JSON.stringify({ ...config, path: launcher }));
const asset = path.join(tmp, "fixture.mp4");
writeFileSync(asset, "fixture");

const executable = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chrome = spawn(executable, [
  "--headless", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
  "--enable-logging=stderr", "--vmodule=native_message_process_host=1", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
  `--user-data-dir=${profile}`, "about:blank"
], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
let logs = "";
chrome.on("error", error => { logs += error.message; });
chrome.stderr.on("data", chunk => { logs += chunk; });
let messageId = 0;
let buffer = "";
const pending = new Map();
const clients = new Map();
function send(method, params = {}, sessionId) {
  const id = ++messageId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(method + " timed out"));
    }, 8000);
    pending.set(id, reply => {
      clearTimeout(timeout);
      if (reply.error) reject(new Error(method + ": " + reply.error.message));
      else resolve(reply.result);
    });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
}
chrome.stdio[4].on("data", chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\0")) !== -1) {
    const data = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (data.id) {
      pending.get(data.id)?.(data);
      pending.delete(data.id);
    } else {
      clients.get(data.sessionId)?.(data);
    }
  }
});
const cli = (...args) => JSON.parse(execFileSync("/usr/bin/python3", ["chrome_agent.py", ...args], {
  env: { ...process.env, HOME: tmp }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}));
async function poll(check) {
  let error;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { return await check(); } catch (cause) { error = cause; }
    await delay(150);
  }
  throw error;
}
let failure = false;
try {
  const { id } = await send("Extensions.loadUnpacked", { path: path.join(root, "extension") });
  assert.equal(config.allowed_origins[0], `chrome-extension://${id}/`);
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Target.activateTarget", { targetId });
  const fixture = Buffer.from('<title>Fixture</title><input id="title"><textarea id="caption"></textarea><div id="editable" contenteditable="true"></div><input id="video" type="file"><input type="password" value="dummy">').toString("base64");
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://member.bilibili.com/*" }] }, sessionId);
  clients.set(sessionId, data => {
    if (data.method === "Fetch.requestPaused") {
      send("Fetch.fulfillRequest", { requestId: data.params.requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: fixture }, sessionId)
        .catch(error => console.error(error.message));
    }
  });
  await send("Page.navigate", { url: "https://member.bilibili.com/fixture" }, sessionId);
  const evaluate = async expression => (await send("Runtime.evaluate", {
    expression, returnByValue: true,
  }, sessionId)).result.value;
  await poll(async () => assert.equal(await evaluate("document.title"), "Fixture"));
  const tabs = await send("Target.getTargets", { filter: [{ type: "tab" }, { exclude: true }] });
  const tabTargetId = tabs.targetInfos.find(tab => tab.url.endsWith("/fixture"))?.targetId;
  assert.ok(tabTargetId, JSON.stringify(tabs));
  // Wait for Chrome to register the extension action before simulating its click.
  await poll(async () => {
    const { targetInfos } = await send("Target.getTargets");
    assert.ok(targetInfos.some(target => target.type === "service_worker" && target.url.includes(id)));
  });
  await send("Extensions.triggerAction", { id, targetId: tabTargetId });
  const info = await poll(() => cli("inspect"));
  assert.equal(info.title, "Fixture");
  assert.ok(!info.controls.some(item => item.type === "password"));
  assert.throws(() => cli("select-file", "#video", path.join(tmp, "missing.mp4")), /No such file/);
  assert.deepEqual(cli("fill", "#title", "标题"), { filled: true });
  assert.deepEqual(cli("fill", "#caption", "简介"), { filled: true });
  assert.deepEqual(cli("fill", "#editable", "<b>literal</b>"), { filled: true });
  assert.equal(await evaluate("document.querySelector('#title').value"), "标题");
  assert.equal(await evaluate("document.querySelector('#caption').value"), "简介");
  assert.equal(await evaluate("document.querySelector('#editable').textContent"), "<b>literal</b>");
  assert.equal(await evaluate("document.querySelectorAll('#editable b').length"), 0);
  assert.deepEqual(cli("select-file", "#video", asset), { selected: true });
  assert.equal(await evaluate("document.querySelector('#video').files[0].name"), "fixture.mp4");
  await send("Page.navigate", { url: "https://member.bilibili.com/another-document" }, sessionId);
  await poll(async () => assert.equal(await evaluate("location.pathname"), "/another-document"));
  await poll(() => assert.throws(() => cli("inspect"), /No active session/));
  await send("Extensions.triggerAction", { id, targetId: tabTargetId });
  await poll(() => cli("inspect"));
  await send("Extensions.triggerAction", { id, targetId: tabTargetId });
  await poll(() => assert.throws(() => cli("inspect"), /No active session/));
  console.log("Chrome end-to-end passed: native host, inspect, fill, select file, navigation and toggle disconnect");
} catch (error) {
  failure = true;
  console.error(error.message);
  console.error(logs.split("\n").filter(line => !line.includes("display_link")).slice(-35).join("\n"));
} finally {
  if (chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill();
    await new Promise(resolve => chrome.once("close", resolve));
  }
  rmSync(tmp, { recursive: true, force: true });
  process.exit(failure ? 1 : 0);
}
