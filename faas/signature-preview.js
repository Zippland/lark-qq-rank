// 入职时长动态签名 · 飞书链接预览云函数（妙笔 FaaS）
// 作用：替代失效的 cgth.ink，在飞书预览签名链接时「服务端实时」计算入职时长。
//
// 关键机制（踩坑结论）：
//   妙笔 /r?fid={id} 的预览不是 GET 转发 query，而是飞书以 POST + url.preview.get
//   事件调用本函数，用户粘贴的原始链接在 body 的 event.context.url 里。
//   所以必须解析 POST body 把参数捞出来；同时兼容 GET 直连（便于命令行测试）。
//
// 接受的参数（来自签名链接的 query）：
//   date     入职日期 YYYY-MM-DD（必填，缺失则回退为一颗 ⭐）
//   template symbols | fullDay | fullMonth（默认 symbols）
//   prefix   前缀文字，如 "Lv. "（可空）
//   k        飞书图标 image_key（可空，作为预览左侧小图）
//   text     自定义文字模式：存在则直接作为预览标题（忽略 date/入职时长逻辑）
//   desc     自定义文字模式的摘要（可空）
module.exports = async function (request, context) {
  function ok(title, imageKey, summary) {
    const inline = { i18n_title: { zh_cn: title } };
    if (summary) inline.i18n_summary = { zh_cn: summary };
    if (imageKey) inline.image_key = imageKey;
    return new Response(JSON.stringify({ inline, expire_strategy: "1day" }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  // 符号规则：每 36 月 👑、每 12 月 ☀️、每 3 月 🌙、每 1 月 ⭐（不足 1 月显示单个 ⭐）
  function symbols(m) {
    if (m < 1) return "⭐";
    return (
      "👑".repeat(Math.floor(m / 36)) +
      "☀️".repeat(Math.floor((m % 36) / 12)) +
      "🌙".repeat(Math.floor((m % 12) / 3)) +
      "⭐".repeat(m % 3)
    ) || "⭐";
  }

  // 在飞书事件对象里深度查找用户粘贴的原始 /r 链接（兜底，防止字段路径变化）
  function findPastedUrl(node) {
    const stack = [node];
    let guard = 0;
    while (stack.length && guard++ < 5000) {
      const cur = stack.pop();
      if (typeof cur === "string") {
        if (cur.indexOf("fid=") >= 0 || cur.indexOf("/r?") >= 0) return cur;
      } else if (cur && typeof cur === "object") {
        for (const k in cur) stack.push(cur[k]);
      }
    }
    return "";
  }

  try {
    // 1) 先尝试 GET query（命令行直连测试时走这里）
    let params = new URL(request.url).searchParams;

    // 2) 飞书预览是 POST，真正的参数藏在 body 的 url.preview.get 事件里
    if (!params.get("date")) {
      let body = "";
      try { body = await request.text(); } catch (e) {}
      if (body) {
        let evt = null;
        try { evt = JSON.parse(body); } catch (e) {}
        const pasted =
          (evt && evt.event && evt.event.context && evt.event.context.url) ||
          (evt && evt.event && evt.event.url) ||
          (evt && findPastedUrl(evt)) ||
          "";
        if (pasted) {
          let urlObj = null;
          try { urlObj = new URL(pasted); } catch (e) {
            try { urlObj = new URL(decodeURIComponent(pasted)); } catch (e2) {}
          }
          if (urlObj) params = urlObj.searchParams;
        }
      }
    }

    const date = (params.get("date") || "").trim();
    const template = (params.get("template") || "symbols").trim();
    const prefix = params.get("prefix") != null ? params.get("prefix") : "";
    const iconKey = (params.get("k") || "").trim();

    // 自定义文字模式：带 text 参数则直接把它作为预览标题（静态），不走入职时长逻辑
    const customText = params.get("text");
    if (customText != null && customText.trim() !== "") {
      const desc = (params.get("desc") || params.get("summary") || "").trim();
      return ok(customText, iconKey, desc);
    }

    const start = new Date(date);
    if (!date || isNaN(start.getTime())) return ok((prefix || "") + "⭐", iconKey);

    // 统一按东八区(UTC+8)口径，避免服务端 UTC 造成月份/天数偏差
    const CST = 8 * 3600 * 1000;
    const startC = new Date(start.getTime() + CST);
    const nowC = new Date(Date.now() + CST);
    const totalDays = Math.floor((nowC.getTime() - startC.getTime()) / 86400000);
    const calMonths =
      (nowC.getUTCFullYear() - startC.getUTCFullYear()) * 12 +
      (nowC.getUTCMonth() - startC.getUTCMonth());
    const dayLevel = Math.floor(totalDays / 30.44);

    let text;
    if (template === "fullDay") {
      const nextLevel = dayLevel + 1;
      const daysLeft = Math.ceil(nextLevel * 30.44 - totalDays);
      text = prefix + dayLevel + " " + symbols(dayLevel) +
        " (还需要 " + daysLeft + " 天升级至 Lv." + nextLevel + ")";
    } else if (template === "fullMonth") {
      const daysLeft = 30 - (totalDays % 30);
      text = prefix + calMonths + " " + symbols(calMonths) +
        " (还需要 " + daysLeft + " 天升级至 Lv." + (calMonths + 1) + ")";
    } else {
      text = prefix + symbols(calMonths);
    }
    return ok(text, iconKey);
  } catch (e) {
    return new Response(
      JSON.stringify({
        inline: { i18n_title: { zh_cn: "签名生成失败" } },
        expire_strategy: "60s",
      }),
      { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }
};
