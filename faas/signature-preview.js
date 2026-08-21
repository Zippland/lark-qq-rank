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
//   template symbols | level | countdown；兼容旧 fullDay / fullMonth
//   format   可组合文案，支持 {等级} {日月星} {剩余天数} {下一等级} {总天数} {疯狂星期四}
//   prefix   旧链接兼容：前缀文字，如 "Lv. "（可空）
//   k        飞书图标 image_key（可空，作为预览左侧小图）
//   text     自定义文字模式：存在则直接作为预览标题（忽略 date/入职时长逻辑）
//   weekday  每周彩蛋模式：当前仅支持 4（北京时间星期四），与 text 搭配使用
//   suffix_text 旧版常驻尾缀兼容：存在且非空时每天追加到主标题；新前端不再生成
//   suffix_sep  旧版常驻尾缀兼容：主标题与尾缀间的分隔符；新前端不再生成
//   thursday_text 疯狂星期四组件文案；旧链接未使用对应占位符时仍作为周四尾缀兼容
//   thursday_sep  旧版周四尾缀连接符；格式含 {疯狂星期四} 时忽略
//   desc     自定义文字模式的摘要（可空）
//   u        点击签名后的跳转目标；由妙笔 /r 路由处理 307，FaaS 不改写链接地址
module.exports = async function (request, context) {
  // 原有主模式没选图标时的默认"链接符号"（取自飞书之父 lark-url-preview），保证这些模式恰好一个 image_key
  const DEFAULT_LINK_ICON = "img_v3_02bj_a88d6829-365b-4bec-a574-5733ba95cc7g";
  const MIN_JOIN_YEAR = 1900;
  function respond(inline, expireStrategy = "1day") {
    return new Response(JSON.stringify({ inline, expire_strategy: expireStrategy }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function ok(title, imageKey, summary, expireStrategy = "1day") {
    const inline = { i18n_title: { zh_cn: title }, image_key: imageKey || DEFAULT_LINK_ICON };
    if (summary) inline.i18n_summary = { zh_cn: summary };
    return respond(inline, expireStrategy);
  }

  function textOnly(title) {
    return respond({ i18n_title: { zh_cn: title } });
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

  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function parseDateParts(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    // 保护日期输入的逐位中间态，也避开 Date.UTC 对 0–99 年按 1900+year 处理的特殊规则。
    if (year < MIN_JOIN_YEAR || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    return { year, month, day };
  }

  function dateNumber(year, month, day) {
    return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  }

  // 入职当日为 Lv.1，此后每到一次月度入职纪念日升级。
  // 29/30/31 日在短月份钳制到月末，但下个月仍从原始入职日重新计算。
  function calculateTenure(start, nowMs) {
    const nowC = new Date(nowMs + 8 * 3600 * 1000);
    const today = {
      year: nowC.getUTCFullYear(),
      month: nowC.getUTCMonth() + 1,
      day: nowC.getUTCDate(),
    };
    const todayNumber = dateNumber(today.year, today.month, today.day);
    const startNumber = dateNumber(start.year, start.month, start.day);

    // 页面会阻止未来日期；FaaS 仍做防御性处理，入职前显示 Lv.0 并倒计时到入职日。
    if (todayNumber < startNumber) {
      return { level: 0, daysLeft: startNumber - todayNumber, nextLevel: 1, totalDays: 0 };
    }

    const monthDiff = (today.year - start.year) * 12 + (today.month - start.month);
    const currentAnniversaryDay = Math.min(start.day, daysInMonth(today.year, today.month));
    const reachedCurrentAnniversary = today.day >= currentAnniversaryDay;
    const level = monthDiff + (reachedCurrentAnniversary ? 1 : 0);

    let nextYear = today.year;
    let nextMonth = today.month;
    if (reachedCurrentAnniversary) {
      nextMonth += 1;
      if (nextMonth === 13) {
        nextMonth = 1;
        nextYear += 1;
      }
    }
    const nextDay = Math.min(start.day, daysInMonth(nextYear, nextMonth));
    const daysLeft = dateNumber(nextYear, nextMonth, nextDay) - todayNumber;
    return { level, daysLeft, nextLevel: level + 1, totalDays: todayNumber - startNumber + 1 };
  }

  function renderFormat(format, tenure, thursdayComponentText) {
    const values = {
      "{等级}": String(tenure.level),
      "{日月星}": symbols(tenure.level),
      "{剩余天数}": String(tenure.daysLeft),
      "{下一等级}": String(tenure.nextLevel),
      "{总天数}": String(tenure.totalDays),
      "{疯狂星期四}": thursdayComponentText,
    };
    return format.replace(/\{等级\}|\{日月星\}|\{剩余天数\}|\{下一等级\}|\{总天数\}|\{疯狂星期四\}/g, (token) => values[token]);
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
    if (request.method !== "GET") {
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
          if (urlObj) {
            params = urlObj.searchParams;
          }
        }
      }
    }

    const date = (params.get("date") || "").trim();
    const template = (params.get("template") || "symbols").trim();
    const prefix = params.get("prefix") != null ? params.get("prefix") : "";
    const iconKey = (params.get("k") || "").trim();
    const customFormat = params.has("format") ? (params.get("format") || "").slice(0, 180) : null;
    const hasThursdayComponent = customFormat != null && customFormat.includes("{疯狂星期四}");
    const CST = 8 * 3600 * 1000;

    // 兼容旧版常驻/周四尾缀；当前前端改用 format 内的 {疯狂星期四} 组件。
    // separator 必须区分“缺失”和“空串”：空串代表用户明确选择紧贴上一段。
    const suffixText = params.get("suffix_text");
    const suffixEnabled = suffixText != null && suffixText.trim() !== "";
    const suffixSeparator = params.has("suffix_sep") ? params.get("suffix_sep") : " ";
    const thursdayText = params.get("thursday_text");
    const thursdayEnabled = thursdayText != null && thursdayText.trim() !== "";
    const thursdaySeparator = params.has("thursday_sep") ? params.get("thursday_sep") : " ";
    const isThursday = new Date(Date.now() + CST).getUTCDay() === 4;
    function appendSuffix(title, enabled, text, separator) {
      if (!enabled) return title;
      // 连接符是两段文案之间唯一的边界；兼容旧链接中 format/text 末尾残留的回车。
      const baseTitle = (title == null ? "" : String(title))
        .replace(/[\s\u200B-\u200D\u2060\uFEFF]*[\r\n\v\f\u0085\u2028\u2029][\s\u200B-\u200D\u2060\uFEFF]*$/u, "");
      const hasVisibleBase = baseTitle.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim() !== "";
      return hasVisibleBase ? baseTitle + separator + text : text;
    }
    function withConfiguredSuffixes(title) {
      const withPersistentSuffix = appendSuffix(title, suffixEnabled, suffixText, suffixSeparator);
      // 新格式组件自行决定位置；只有旧链接才继续把星期四文案追加在末尾。
      return appendSuffix(
        withPersistentSuffix,
        !hasThursdayComponent && thursdayEnabled && isThursday,
        thursdayText,
        thursdaySeparator,
      );
    }

    // 拼字模式：每个图块一个 raw 预览。title = 文本（换行符或空→零宽空格），image_key = 该图块。
    // 前端把多个这种链接用空格拼起来，粘进签名后每 5 块换行，拼成 5×5 大图。
    if (params.get("raw") != null) {
      const t = params.get("t");
      const rawTitle = (t != null && t !== "") ? t : "​";
      return ok(withConfiguredSuffixes(rawTitle), iconKey);
    }

    // 独立周四彩蛋：按北京时间决定是否展示，隐藏时保留零宽标题占位。
    // 此分支只负责文字展示，不带 image_key，也不改写点击 URL。
    if ((params.get("weekday") || "").trim() === "4") {
      const customText = params.get("text");
      const visibleText = customText != null && customText.trim() !== "" ? customText : "\u200B";
      return textOnly(isThursday ? visibleText : "\u200B");
    }

    // 自定义文字模式：带 text 参数则直接把它作为预览标题（静态），不走入职时长逻辑
    const customText = params.get("text");
    if (customText != null && customText.trim() !== "") {
      const desc = (params.get("desc") || params.get("summary") || "").trim();
      return ok(withConfiguredSuffixes(customText), iconKey, desc);
    }

    const start = parseDateParts(date);
    if (!start) return ok(withConfiguredSuffixes((prefix || "") + "⭐"), iconKey);

    const tenure = calculateTenure(start, Date.now());
    let text;
    if (customFormat != null) {
      const thursdayComponentText = isThursday && thursdayEnabled ? thursdayText : "";
      text = renderFormat(customFormat, tenure, thursdayComponentText);
    } else if (template === "level") {
      const levelPrefix = params.has("prefix") ? prefix : "Lv. ";
      text = levelPrefix + tenure.level + " " + symbols(tenure.level);
    } else if (template === "countdown") {
      const levelPrefix = params.has("prefix") ? prefix : "Lv. ";
      text = levelPrefix + tenure.level + " " + symbols(tenure.level) +
        "（还需要 " + tenure.daysLeft + " 天升级至 Lv." + tenure.nextLevel + "）";
    } else if (template === "fullDay" || template === "fullMonth") {
      text = prefix + tenure.level + " " + symbols(tenure.level) +
        " (还需要 " + tenure.daysLeft + " 天升级至 Lv." + tenure.nextLevel + ")";
    } else {
      text = prefix + symbols(tenure.level);
    }
    return ok(withConfiguredSuffixes(text), iconKey);
  } catch (e) {
    return ok("签名生成失败", DEFAULT_LINK_ICON, "", "60s");
  }
};
