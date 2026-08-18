const test = require("node:test");
const assert = require("node:assert/strict");

const signaturePreview = require("./signature-preview.js");

const API_URL = "https://magic.solutionsuite.cn/api/faas/test-fid";

async function invoke(url, init) {
  const response = await signaturePreview(new Request(url, init), {});
  assert.equal(response.status, 200);
  return response.json();
}

function previewUrl(params) {
  const query = new URLSearchParams({ fid: "test-fid", ...params });
  return `https://magic.solutionsuite.cn/r?${query.toString()}`;
}

function previewRequest(url, endpoint = API_URL) {
  return invoke(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: { context: { url } } }),
  });
}

function assertInlineOnly(result) {
  assert.equal(Object.hasOwn(result.inline, "url"), false);
  assert.equal(typeof result.inline.image_key, "string");
  assert.notEqual(result.inline.image_key, "");
}

test("POST 预览返回动态标题，但不改写点击 URL", async () => {
  const pastedUrl = previewUrl({
    text: "☀️🌙⭐",
    u: "https://bytedance.larkoffice.com/docx/example",
  });
  const result = await previewRequest(pastedUrl);

  assert.equal(result.inline.i18n_title.zh_cn, "☀️🌙⭐");
  assertInlineOnly(result);
});

test("GET 直连兼容自定义文字且不返回 inline.url", async () => {
  const url = `${API_URL}?${new URLSearchParams({
    text: "hello",
    u: "https://example.com/target",
  })}`;
  const result = await invoke(url);

  assert.equal(result.inline.i18n_title.zh_cn, "hello");
  assertInlineOnly(result);
});

test("raw、自定义文字和无效日期分支都只返回展示数据", async (t) => {
  const cases = [
    { name: "raw", params: { raw: "1", t: "", k: "img_test" } },
    { name: "custom", params: { text: "自定义", desc: "摘要" } },
    { name: "invalid date", params: { date: "not-a-date", prefix: "Lv. " } },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const result = await previewRequest(previewUrl(item.params));
      assertInlineOnly(result);
    });
  }
});

test("POST body 的预览链接优先于接口自身 query", async () => {
  const result = await previewRequest(
    previewUrl({ text: "body wins" }),
    `${API_URL}?date=2000-01-01`,
  );

  assert.equal(result.inline.i18n_title.zh_cn, "body wins");
  assertInlineOnly(result);
});

test("u 中复杂 query 不影响动态标题", async () => {
  const targetUrl = "https://example.com/path?q=hello%20world&next=%252F#part";
  const result = await previewRequest(previewUrl({ text: "动态标题", u: targetUrl }));

  assert.equal(result.inline.i18n_title.zh_cn, "动态标题");
  assertInlineOnly(result);
});

test("异常响应保留图标并缩短缓存", async () => {
  const response = await signaturePreview({ url: "not a valid URL", method: "GET" }, {});
  const result = await response.json();

  assert.equal(result.inline.i18n_title.zh_cn, "签名生成失败");
  assert.equal(result.expire_strategy, "60s");
  assertInlineOnly(result);
});
