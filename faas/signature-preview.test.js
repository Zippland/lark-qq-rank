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

function assertTextOnly(result) {
  assert.equal(Object.hasOwn(result.inline, "url"), false);
  assert.equal(Object.hasOwn(result.inline, "image_key"), false);
  assert.equal(result.expire_strategy, "1day");
}

async function withNow(isoTime, callback) {
  const originalNow = Date.now;
  Date.now = () => new Date(isoTime).getTime();
  try {
    return await callback();
  } finally {
    Date.now = originalNow;
  }
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

test("周四尾缀严格按北京时间的日期边界追加到主标题", async (t) => {
  const cases = [
    {
      name: "周三 23:59:59 保持原标题",
      now: "2026-08-19T15:59:59.000Z",
      expected: "主签名",
    },
    {
      name: "周四 00:00:00 开始追加",
      now: "2026-08-19T16:00:00.000Z",
      expected: "主签名 🔥 V50 🔥",
    },
    {
      name: "周四 23:59:59 仍然追加",
      now: "2026-08-20T15:59:59.000Z",
      expected: "主签名 🔥 V50 🔥",
    },
    {
      name: "周五 00:00:00 恢复原标题",
      now: "2026-08-20T16:00:00.000Z",
      expected: "主签名",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      await withNow(item.now, async () => {
        const result = await previewRequest(previewUrl({
          text: "主签名",
          thursday_text: "🔥 V50 🔥",
          k: "img_custom",
          u: "https://example.com/target",
        }));

        assert.equal(result.inline.i18n_title.zh_cn, item.expected);
        assert.equal(result.inline.image_key, "img_custom");
        assertInlineOnly(result);
      });
    });
  }
});

test("周四尾缀支持默认、空串、符号、换行和自定义分隔符", async (t) => {
  const cases = [
    { name: "缺失时默认空格", separator: undefined, expected: "正文 尾缀" },
    { name: "显式空串时紧贴", separator: "", expected: "正文尾缀" },
    { name: "符号", separator: "｜", expected: "正文｜尾缀" },
    { name: "换行", separator: "\n", expected: "正文\n尾缀" },
    { name: "自定义字符串", separator: " · ", expected: "正文 · 尾缀" },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      await withNow("2026-08-19T16:00:00.000Z", async () => {
        const params = { text: "正文", thursday_text: "尾缀", k: "img_separator" };
        if (item.separator !== undefined) params.thursday_sep = item.separator;
        const result = await previewRequest(previewUrl(params));

        assert.equal(result.inline.i18n_title.zh_cn, item.expected);
        assert.equal(result.inline.image_key, "img_separator");
        assertInlineOnly(result);
      });
    });
  }
});

test("空白周四尾缀不启用且不追加分隔符", async (t) => {
  const cases = [
    { name: "缺失", params: {} },
    { name: "空串", params: { thursday_text: "" } },
    { name: "纯空白", params: { thursday_text: "   " } },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      await withNow("2026-08-19T16:00:00.000Z", async () => {
        const result = await previewRequest(previewUrl({
          text: "正文",
          thursday_sep: "不应出现",
          ...item.params,
        }));

        assert.equal(result.inline.i18n_title.zh_cn, "正文");
        assertInlineOnly(result);
      });
    });
  }
});

test("周四尾缀覆盖入职时长、自定义文字和 raw 图标模式并保留各自图标", async (t) => {
  const cases = [
    {
      name: "入职时长",
      params: { date: "2025-08-20", thursday_text: "尾缀", thursday_sep: " / ", k: "img_tenure" },
      expectedTitle: "☀️ / 尾缀",
      expectedIcon: "img_tenure",
    },
    {
      name: "自定义文字",
      params: { text: "自定义", thursday_text: "尾缀", thursday_sep: " / ", k: "img_custom" },
      expectedTitle: "自定义 / 尾缀",
      expectedIcon: "img_custom",
    },
    {
      name: "raw 带原标题",
      params: { raw: "1", t: "图块文字", thursday_text: "尾缀", thursday_sep: " / ", k: "img_raw_text" },
      expectedTitle: "图块文字 / 尾缀",
      expectedIcon: "img_raw_text",
    },
    {
      name: "raw 图标-only 的零宽原标题",
      params: { raw: "1", t: "", thursday_text: "尾缀", thursday_sep: "不应出现", k: "img_raw_only" },
      expectedTitle: "尾缀",
      expectedIcon: "img_raw_only",
    },
    {
      name: "raw 多个零宽字符",
      params: { raw: "1", t: "\u200B\u2060\uFEFF", thursday_text: "尾缀", thursday_sep: "不应出现", k: "img_raw_zw" },
      expectedTitle: "尾缀",
      expectedIcon: "img_raw_zw",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      await withNow("2026-08-19T16:00:00.000Z", async () => {
        const result = await previewRequest(previewUrl(item.params));

        assert.equal(result.inline.i18n_title.zh_cn, item.expectedTitle);
        assert.equal(result.inline.image_key, item.expectedIcon);
        assertInlineOnly(result);
      });
    });
  }
});

test("周四尾缀优先使用 POST body URL 的标题、尾缀和分隔符", async () => {
  await withNow("2026-08-19T16:00:00.000Z", async () => {
    const result = await previewRequest(
      previewUrl({
        text: "body title",
        thursday_text: "body suffix",
        thursday_sep: "\n",
        k: "img_body",
      }),
      `${API_URL}?text=query+title&thursday_text=query+suffix&thursday_sep=%2F&k=img_query`,
    );

    assert.equal(result.inline.i18n_title.zh_cn, "body title\nbody suffix");
    assert.equal(result.inline.image_key, "img_body");
    assertInlineOnly(result);
  });
});

test("周四彩蛋严格按北京时间的日期边界显示", async (t) => {
  const text = "🔥 CrazyThursdayVme50 🔥";
  const cases = [
    {
      name: "周三 23:59:59 隐藏",
      now: "2026-08-19T15:59:59.000Z",
      expected: "\u200B",
    },
    {
      name: "周四 00:00:00 显示",
      now: "2026-08-19T16:00:00.000Z",
      expected: text,
    },
    {
      name: "周四 23:59:59 显示",
      now: "2026-08-20T15:59:59.000Z",
      expected: text,
    },
    {
      name: "周五 00:00:00 隐藏",
      now: "2026-08-20T16:00:00.000Z",
      expected: "\u200B",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      await withNow(item.now, async () => {
        const result = await previewRequest(previewUrl({
          weekday: "4",
          text,
          k: "img_must_not_be_returned",
          u: "https://example.com/target",
        }));

        assert.equal(result.inline.i18n_title.zh_cn, item.expected);
        assertTextOnly(result);
      });
    });
  }
});

test("周四彩蛋优先使用 POST body URL 且不返回 inline.url", async () => {
  await withNow("2026-08-19T16:00:00.000Z", async () => {
    const result = await previewRequest(
      previewUrl({ weekday: "4", text: "body wins", k: "img_body" }),
      `${API_URL}?text=query+loses&k=img_query`,
    );

    assert.equal(result.inline.i18n_title.zh_cn, "body wins");
    assertTextOnly(result);
  });
});

test("周四彩蛋的缺失、空串或纯空白 text 都返回零宽字符", async (t) => {
  const cases = [
    { name: "缺失", params: { weekday: "4" } },
    { name: "空串", params: { weekday: "4", text: "" } },
    { name: "纯空白", params: { weekday: "4", text: "   " } },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      await withNow("2026-08-19T16:00:00.000Z", async () => {
        const result = await previewRequest(previewUrl(item.params));

        assert.equal(result.inline.i18n_title.zh_cn, "\u200B");
        assertTextOnly(result);
      });
    });
  }
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
