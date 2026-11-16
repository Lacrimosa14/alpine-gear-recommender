/* =========================================================
   小熊猫户外 · 登山装备智能推荐
   引擎：硬约束 filter_rules（一票否决）+ 打分 score_rules（命中累加权重）
   数据：window.ALPINE_DATA = { products, mountains, rules, user }
   ========================================================= */
(function () {
  'use strict';

  var DATA = window.ALPINE_DATA || {};

  /* ---------- 基础工具 ---------- */
  function str(v) { return v === null || v === undefined ? '' : String(v).trim(); }
  function toNum(v) {
    if (typeof v === 'number') return v;
    var m = str(v).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : NaN;
  }
  function esc(s) {
    return str(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 品类派生（与推荐系统一致） ---------- */
  function classifyCategory(name) {
    if (/(连衣裙|裙子|裙装)/.test(name)) return '裙装';
    if (/西装/.test(name)) return '西装';
    if (/(衬衫|衬衣)/.test(name)) return '衬衫';
    if (/裙裤/.test(name)) return '裙裤';
    if (/T恤/.test(name)) return 'T恤';
    if (/(牛仔裤|长裤|紧身裤|打底裤|裤)/.test(name)) return '裤装';
    if (/(外套|开衫|防晒|摇粒绒|连帽|夹克)/.test(name)) return '外套';
    return '其他';
  }
  function enrich(p) {
    p['品类'] = classifyCategory(str(p['产品名称']));
    return p;
  }

  /* ---------- 规则匹配（复刻引擎语义） ---------- */
  function matches(user, product, rule) {
    var u = str(user[rule.userField]);
    var p = str(product[rule.productField]);
    if (u === '') return false;
    switch (rule.matchType) {
      case 'equal': return u === p;
      case 'contains': return p.indexOf(u) !== -1;
      case 'map': {
        var keys = (rule.dictionary || {})[u];
        if (!keys || !keys.length) return false;
        for (var i = 0; i < keys.length; i++) { if (p.indexOf(keys[i]) !== -1) return true; }
        return false;
      }
      case 'range': {
        var m = p.match(/(\d+(?:\.\d+)?)\s*[~\-—–]\s*(\d+(?:\.\d+)?)/);
        if (!m) return false;
        var uv = toNum(u);
        return !isNaN(uv) && uv >= parseFloat(m[1]) && uv <= parseFloat(m[2]);
      }
      case 'compare': {
        var a = toNum(u), b = toNum(p);
        if (isNaN(a) || isNaN(b)) return false;
        switch (rule.op || '>=') {
          case '>': return b > a;
          case '>=': return b >= a;
          case '<': return b < a;
          case '<=': return b <= a;
          case '=': case '==': return b === a;
          default: return false;
        }
      }
      default: return false;
    }
  }


  /* ---------- 推荐 ---------- */
  var PRODUCTS = (DATA.products || []).map(enrich);
  var MOUNTAINS = DATA.mountains || [];
  var RULES = DATA.rules || { filter_rules: [], score_rules: [] };
  var DEMO = DATA.user || {};

  function recommend(products, user, rules) {
    var filters = (rules.filter_rules || []).filter(function (r) { return r.enabled !== false; });
    var scorers = (rules.score_rules || []).filter(function (r) { return r.enabled !== false; });
    var rows = products.map(function (product, idx) {
      for (var i = 0; i < filters.length; i++) {
        var fr = filters[i];
        if (str(user[fr.userField]) === '') continue;
        if (!matches(user, product, fr)) {
          return { product: product, idx: idx, dropped: true, reason: '规则：' + (fr.name || fr.userField), score: 0, hits: [] };
        }
      }
      var score = 0, hits = [];
      for (var j = 0; j < scorers.length; j++) {
        var sr = scorers[j];
        if (str(user[sr.userField]) === '') continue;
        if (matches(user, product, sr)) {
          var w = Number(sr.weight) || 0;
          score += w;
          hits.push({ name: sr.name || sr.userField, w: w });
        }
      }
      return { product: product, idx: idx, dropped: false, reason: '', score: score, hits: hits };
    });
    var kept = rows.filter(function (r) { return !r.dropped; })
                   .sort(function (a, b) { return (b.score - a.score) || (a.idx - b.idx); });
    return { kept: kept, dropped: rows.filter(function (r) { return r.dropped; }), total: products.length,
             reasons: filterStats(products, user, filters) };
  }

  /* 每条硬约束「单独」剔除的款数，用于结果偏少/为空时解释原因 */
  function filterStats(products, user, filters) {
    return filters.map(function (fr) {
      if (str(user[fr.userField]) === '') return null;
      var n = 0;
      for (var i = 0; i < products.length; i++) if (!matches(user, products[i], fr)) n++;
      return { name: fr.name || fr.userField, n: n };
    }).filter(function (x) { return x; });
  }

  var FILTER_ADVICE = {
    '性别匹配': '先把性别改成对应款式（男女款均有则不受限）',
    '气候适配': '换一个季节/气候，或选择跨季款',
    '装备类型匹配': '改选其他「装备类型需求」，或留空不限制',
    '防水硬约束': '把「防水需求」下调一档（强→中→弱）',
    '预算硬约束': '提高「预算上限」'
  };

  function diagHtml(intro, list) {
    var sorted = list.slice().sort(function (a, b) { return b.n - a.n; })
                     .filter(function (r) { return r.n > 0; });
    var lines = sorted.map(function (r) {
      return '<div>· <b>' + esc(r.name) + '</b> 单独剔除 <b>' + r.n + '</b> 款（可试：' +
        esc(FILTER_ADVICE[r.name] || '放宽该项') + '）</div>';
    }).join('') || '<div>· 当前各硬约束均未剔除商品。</div>';
    var main = sorted[0];
    return '<div class="empty" style="text-align:left;line-height:1.95;grid-column:1/-1;padding:26px 28px">' +
      '<div style="margin-bottom:10px"><b>' + esc(intro) + '</b></div>' + lines +
      '<div style="margin-top:8px;font-size:12.5px;opacity:.85">注：以上按每条硬约束单独统计，同一商品可能同时不满足多条，故合计数可大于商品总数。</div>' +
      (main ? '<div style="margin-top:8px">主要限制来自「<b>' + esc(main.name) + '</b>」，建议优先：' +
        esc(FILTER_ADVICE[main.name] || '放宽该项') + '。</div>' : '') +
      '</div>';
  }

  /* ---------- DOM 引用 ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var state = { chips: {}, mountain: null };

  /* ---------- toast ---------- */
  var toastEl = $('toast'), toastTimer = null;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2400);
  }

  /* ---------- chips ---------- */
  function setChip(name, value) {
    state.chips[name] = value || '';
    var box = document.querySelector('.chips[data-chip="' + name + '"]');
    if (!box) return;
    var btns = box.querySelectorAll('.chip');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', String(btns[i].getAttribute('data-value') === state.chips[name]));
    }
  }
  function initChips() {
    var boxes = document.querySelectorAll('.chips[data-chip]');
    for (var b = 0; b < boxes.length; b++) {
      (function (box) {
        var name = box.getAttribute('data-chip');
        state.chips[name] = '';
        var chips = box.querySelectorAll('.chip');
        for (var i = 0; i < chips.length; i++) {
          (function (btn) {
            btn.setAttribute('aria-pressed', 'false');
            btn.addEventListener('click', function () {
              var v = btn.getAttribute('data-value');
              setChip(name, state.chips[name] === v ? '' : v);
            });
          })(chips[i]);
        }
      })(boxes[b]);
    }
  }

  /* ---------- 山峰库 ---------- */
  var mtnRegion = '全部';
  function bandOf(m) { return m.band || '低海拔'; }
  function weatherOf(m) {
    var rain = toNum(m.rain), wind = toNum(m.wind);
    if (rain >= 45 || (rain >= 35 && wind >= 6)) return '多雨大风';
    if (rain >= 30) return '多雨';
    return '晴好';
  }
  function sceneOf(m) {
    var band = bandOf(m);
    if (band.indexOf('高海拔') === 0) return '高海拔技术';
    if (band.indexOf('中海拔') === 0) return m.diff === '入门' ? '城市近郊单日' : '中高海拔多日';
    return '城市近郊单日';
  }
  function gearOf(m) {
    var band = bandOf(m);
    if (band.indexOf('高海拔') === 0) return '硬壳';
    if (band.indexOf('中海拔') === 0) return m.diff === '高难度' ? '硬壳' : '三合一';
    return m.diff === '入门' ? '软壳' : '风壳';
  }
  function heatOf(m) {
    var band = bandOf(m);
    if (band.indexOf('高海拔') === 0) return '强效保暖';
    if (band.indexOf('中海拔') === 0) return '中等保暖';
    return '轻量透气';
  }

  function renderRegions() {
    var box = $('mtnRegions');
    if (!box) return;
    var regions = ['全部'];
    MOUNTAINS.forEach(function (m) { if (regions.indexOf(m.region) === -1) regions.push(m.region); });
    box.innerHTML = regions.map(function (r) {
      return '<button class="chip" data-region="' + esc(r) + '" aria-pressed="' + (r === mtnRegion) + '">' + esc(r) + '</button>';
    }).join('');
    box.addEventListener('click', function (e) {
      var t = e.target.closest('.chip');
      if (!t) return;
      mtnRegion = t.getAttribute('data-region');
      var all = box.querySelectorAll('.chip');
      for (var i = 0; i < all.length; i++) {
        all[i].setAttribute('aria-pressed', String(all[i].getAttribute('data-region') === mtnRegion));
      }
      renderMountains();
    });
  }

  function renderMountains() {
    var grid = $('mtnGrid');
    if (!grid) return;
    var kw = str(($('mtnSearch') || {}).value).toLowerCase();
    var list = MOUNTAINS.filter(function (m) {
      if (mtnRegion !== '全部' && m.region !== mtnRegion) return false;
      if (!kw) return true;
      return (str(m.name) + str(m.province) + str(m.region)).toLowerCase().indexOf(kw) !== -1;
    });
    if (!list.length) {
      grid.innerHTML = '<div class="empty">没有匹配的山峰，换个关键词试试。</div>';
      return;
    }
    grid.innerHTML = list.map(function (m) {
      var on = state.mountain && state.mountain.name === m.name;
      return '<button class="mtn-card" data-name="' + esc(m.name) + '" aria-pressed="' + !!on + '">' +
        '<div class="m-name">' + esc(m.name) + ' <span class="pill">' + esc(bandOf(m)) + '</span></div>' +
        '<div class="m-region">' + esc(m.region) + ' · ' + esc(m.province) + '</div>' +
        '<div class="m-meta">' +
          '<span>海拔 ' + esc(m.alt) + 'm</span>' +
          '<span>' + esc(m.diff) + '</span>' +
          '<span>爬升 ' + esc(m.climb) + 'm</span>' +
          '<span>' + esc(m.dist) + 'km / ' + esc(m.hours) + 'h</span>' +
          '<span>山顶全年 ' + esc(m.topSA) + '</span>' +
          '<span>降水概率 ' + esc(m.rain) + '%</span>' +
          '<span>风速 ' + esc(m.wind) + ' m/s</span>' +
        '</div>' +
      '</button>';
    }).join('');
  }

  function findMountain(name) {
    for (var i = 0; i < MOUNTAINS.length; i++) { if (MOUNTAINS[i].name === name) return MOUNTAINS[i]; }
    return null;
  }

  /* ---------- 预计温度与天气（山峰 + 季节） ---------- */
  function seasonNow() { return str(($('f_season') || {}).value) || '秋季'; }

  function renderForecast() {
    var box = $('forecast');
    if (!box) return;
    var t = $('fcTemp'), tn = $('fcTempNote'), w = $('fcWeather'), wn = $('fcWeatherNote'), e = $('fcExtra'), en = $('fcExtraNote');
    var m = state.mountain, season = seasonNow();
    if (!m) {
      box.classList.add('is-empty');
      if (t) t.textContent = '—';
      if (tn) tn.textContent = '在 Step 01 选定山峰后显示';
      if (w) w.textContent = '—';
      if (wn) wn.innerHTML = '&nbsp;';
      if (e) e.textContent = '—';
      if (en) en.innerHTML = '&nbsp;';
      return;
    }
    var warm = season === '春季' || season === '夏季';
    box.classList.remove('is-empty');
    if (t) t.textContent = (warm ? m.topSA : m.topAW) || '—';
    if (tn) tn.textContent = '峰顶 · ' + (warm ? '春夏季' : '秋冬季') + '（山下海拔 ' + m.base + 'm）';
    if (w) w.textContent = weatherOf(m);
    if (wn) wn.textContent = '全年降水概率 ' + m.rain + '%';
    if (e) e.textContent = '风速 ' + m.wind + ' m/s';
    if (en) en.textContent = '山顶与山下温差 ' + m.tempDiff;
  }

  /* ---------- 推荐外套类型与功能（山峰 → 类型 + 功能） ---------- */
  function gearTipOf(m) {
    var type = gearOf(m);
    var w = weatherOf(m);
    var wind = toNum(m.wind);
    var funcs = [];
    var wet = w !== '晴好';
    if (type === '硬壳') {
      funcs.push(wet ? '防水：强（≥20,000mmH₂O，全压胶 + 防水拉链）' : '防水：中等（≥10,000mmH₂O）');
    } else if (type === '三合一') {
      funcs.push(wet ? '防水：中等偏强（≥10,000mmH₂O，外层可拆）' : '防水：中等（≥10,000mmH₂O）');
    } else if (type === '软壳') {
      funcs.push('防水：防泼水 DWR（短时小雨，透气优先）');
    } else if (type === '风壳') {
      funcs.push('防水：防泼水 DWR（挡风为主、仅防小雨）');
    } else {
      funcs.push('防水：防泼水 DWR（外层需另配冲锋衣）');
    }
    funcs.push(wind >= 6 ? '防风：强（立体风帽、下摆与袖口收紧）' : '防风：中等（可调风帽）');
    funcs.push('保暖：' + heatOf(m) + '（由内层/中层调节）');
    funcs.push(type === '三合一' ? '结构：可拆抓绒内胆，一衣跨季' : '结构：单层外壳，搭配抓绒或羽绒中层');
    if (type === '硬壳') funcs.push('透湿：≥15,000g/m²·24h，腋下透气拉链 + 头盔兼容帽');
    if (type === '软壳') funcs.push('细节：四面弹面料，活动量大时更舒服');
    if (type === '风壳') funcs.push('细节：轻量可收纳，适合快速行进');
    if (type === '羽绒') funcs.push('细节：高蓬松度填充，静态保暖最强');
    if (type === '棉服') funcs.push('细节：化纤保暖，受潮后仍保温');
    var why = '依据：' + bandOf(m) + ' · 海拔 ' + str(m.alt) + 'm · 降水概率 ' + str(m.rain) +
      '% · 风速 ' + str(m.wind) + ' m/s · 难度 ' + str(m.diff);
    return { type: type, funcs: funcs, why: why };
  }

  function renderGearTip() {
    var box = $('gearTip');
    if (!box) return;
    var t = $('gtType'), f = $('gtFunc'), y = $('gtWhy');
    var m = state.mountain;
    if (!m) {
      box.classList.add('is-empty');
      if (t) t.textContent = '—';
      if (f) f.textContent = '选定山峰后显示推荐外套类型与关键功能';
      if (y) y.innerHTML = '&nbsp;';
      return;
    }
    var g = gearTipOf(m);
    box.classList.remove('is-empty');
    if (t) t.textContent = g.type;
    if (f) f.innerHTML = g.funcs.map(function (x) { return '<span class="pill">' + esc(x) + '</span>'; }).join('');
    if (y) y.textContent = g.why;
  }

  function prefillFromMountain(m) {
    if (!m) { toast('请先在上方选择一座山峰'); return; }
    state.mountain = m;
    state.band = bandOf(m);
    state.diff = m.diff;
    setChip('使用场景', sceneOf(m));
    setChip('天气', weatherOf(m));
    setChip('装备类型需求', gearOf(m));
    setChip('防水需求', weatherOf(m) === '晴好' ? '中' : '强');
    setChip('防风需求', toNum(m.wind) >= 6 ? '强' : '中');
    setChip('保暖需求', heatOf(m));
    setChip('可拆内胆需求', '否');
    var g = $('f_gender');
    if (g && m.band && m.name) { /* 性别保持用户输入 */ }
    renderMountains();
    renderForecast();
    renderGearTip();
    renderCondChips(buildUser(), true);
    toast('已选「' + m.name + '」· 已按海拔/天气/难度预填条件');
  }

  /* ---------- 读取表单 ---------- */
  function valNum(id, fb) {
    var v = toNum(($(id) || {}).value);
    return isNaN(v) ? fb : v;
  }
  function buildUser() {
    return {
      '性别': str(($('f_gender') || {}).value) || '男',
      '年龄': valNum('f_age', 30),
      '健康状况': str(($('f_health') || {}).value) || '',
      '预算上限': valNum('f_budget', 5000),
      '重量上限(g)': valNum('f_weight', 600),
      '季节/气候': str(($('f_season') || {}).value) || '',
      '使用场景': state.chips['使用场景'] || '',
      '天气': state.chips['天气'] || '',
      '装备类型需求': state.chips['装备类型需求'] || '',
      '防水需求': state.chips['防水需求'] || '',
      '防风需求': state.chips['防风需求'] || '',
      '保暖需求': state.chips['保暖需求'] || '',
      '可拆内胆需求': state.chips['可拆内胆需求'] || '',
      '目标山峰': state.mountain ? state.mountain.name : '',
      '海拔档位': state.band || '',
      '路线难度': state.diff || ''
    };
  }

  /* ---------- 条件摘要 ---------- */
  var COND_LABEL = {
    '性别': '性别', '健康状况': '健康状况',
    '预算上限': '预算', '重量上限(g)': '重量上限', '季节/气候': '季节',
    '使用场景': '场景', '天气': '天气', '装备类型需求': '类型', '防水需求': '防水',
    '防风需求': '防风', '保暖需求': '保暖', '可拆内胆需求': '可拆内胆',
    '目标山峰': '山峰', '海拔档位': '海拔档', '路线难度': '难度'
  };
  function renderCondChips(user, brief) {
    var box = $('condChips');
    if (!box || !user) return;
    var order = ['目标山峰', '海拔档位', '路线难度', '使用场景', '天气', '季节/气候', '装备类型需求', '防水需求', '防风需求', '保暖需求', '可拆内胆需求', '健康状况', '性别'];
    var out = [];
    order.forEach(function (k) {
      var v = user[k];
      if (v === '' || v === undefined || v === null) return;
      if (k === '可拆内胆需求' && v === '否' && brief) return;
      var txt = COND_LABEL[k] + '：' + v + (k === '预算上限' ? ' 元' : k === '重量上限(g)' ? 'g' : '');
      out.push('<span class="chip" style="pointer-events:none">' + esc(txt) + '</span>');
    });
    box.innerHTML = out.join('') || '<span class="chip" style="pointer-events:none;opacity:.6">尚未设定条件</span>';
  }

  /* ---------- 结果渲染 ---------- */
  function renderResult(user, res) {
    var N = 9;
    var kept = res.kept.slice(0, N);
    var top = kept.length ? kept[0].score : 0;
    var sum = $('summary');
    if (sum) {
      sum.innerHTML = '本次共评估 <b>' + res.total + '</b> 款 · 硬约束剔除 <b>' + res.dropped.length +
        '</b> 款 · 保留 <b>' + res.kept.length + '</b> 款 · 下列为按总分降序的 Top <b>' + kept.length +
        '</b>（最高 <b>' + top + '</b> 分）';
    }
    var hint = $('resultHint');
    if (hint) {
      hint.textContent = '已按「' + (user['目标山峰'] || '未指定山峰') + ' · ' + (user['使用场景'] || '未指定场景') +
        '」生成推荐；每张卡片下方列出命中的打分规则与权重。';
    }
    renderCondChips(user, false);

    var cards = $('cards');
    if (cards) {
      if (!kept.length) {
        cards.innerHTML = diagHtml('没有满足全部硬约束的装备，逐条原因如下：', res.reasons || []);
      } else {
        cards.innerHTML = (res.kept.length < 10
            ? diagHtml('仅匹配到 ' + res.kept.length + ' 款，条件偏严，各硬约束的剔除量如下：', res.reasons || [])
            : '') +
          kept.map(function (r, i) {
          var p = r.product;
          var specs = [
            '¥' + esc(p['参考价格(元)']),
            esc(p['重量(g)']) + 'g',
            '防水 ' + esc(p['防水级别']),
            '防风 ' + esc(p['防风级别']),
            esc(p['保暖等级'])
          ].map(function (s) { return '<span class="pill">' + s + '</span>'; }).join('');
          var hits = r.hits.length
            ? r.hits.map(function (h) { return '<span class="h">' + esc(h.name) + ' <b>+' + h.w + '</b></span>'; }).join('')
            : '<span class="h">未命中打分项</span>';
          return '<article class="card">' +
            '<div class="rank">No.' + String(i + 1).padStart(2, '0') + '</div>' +
            '<div class="score-badge"><b>' + r.score + '</b><span>score</span></div>' +
            '<div class="band"><span class="cat">' + esc(p['类别']) + '</span></div>' +
            '<div class="body">' +
              '<div class="pname">' + esc(p['产品名称']) + '</div>' +
              '<div class="pbrand">' + esc(p['品牌']) + '</div>' +
              '<div class="specs">' + specs + '</div>' +
              '<div class="kvs">' +
                '<div><i>货号</i> ' + esc(p['货号']) + '</div>' +
                '<div><i>适用季节</i> ' + esc(p['适用季节']) + '</div>' +
                '<div><i>高海拔</i> ' + esc(p['是否适合高海拔']) + '</div>' +
                '<div><i>防水膜</i> ' + esc(p['防水透湿膜'] || '—') + '</div>' +
                '<div><i>版型</i> ' + esc(p['版型/剪裁'] || '—') + '</div>' +
                '<div><i>内胆</i> ' + esc(p['是否可拆卸内胆'] || '—') + '</div>' +
              '</div>' +
              '<div class="hits">' + hits + '</div>' +
            '</div>' +
          '</article>';
        }).join('');
      }
    }

    var cnt = $('dropCount'), body = $('dropBody');
    if (cnt) cnt.textContent = res.dropped.length;
    if (body) {
      body.innerHTML = res.dropped.length
        ? '<table class="drop-table"><thead><tr><th>货号</th><th>产品名称</th><th>品牌</th><th>剔除原因</th></tr></thead><tbody>' +
          res.dropped.map(function (r) {
            return '<tr><td>' + esc(r.product['货号']) + '</td><td>' + esc(r.product['产品名称']) + '</td><td>' +
              esc(r.product['品牌']) + '</td><td><span class="reason">' + esc(r.reason) + '</span></td></tr>';
          }).join('') + '</tbody></table>'
        : '<div class="empty" style="border:0">本条件下没有被剔除的商品。</div>';
    }
  }

  /* ---------- 规则面板 ---------- */
  function typeText(r) {
    switch (r.matchType) {
      case 'map': return 'map · 用户值经字典映射命中关键词';
      case 'contains': return 'contains · 产品值包含用户值';
      case 'equal': return 'equal · 完全相等';
      case 'range': return 'range · 落入产品区间';
      case 'compare': return 'compare ' + (r.op || '>=') + ' · 数值比较';
      default: return r.matchType || '';
    }
  }
  function renderRules() {
    var f = $('ruleFilters');
    if (f) {
      var fr = RULES.filter_rules || [];
      f.innerHTML = fr.length ? fr.map(function (r) {
        return '<li><span class="mt">' + esc(r.matchType) + '</span><div><b>' + esc(r.name || r.userField) + '</b><br>' +
          '<span style="color:var(--muted)">用户「' + esc(r.userField) + '」 → 产品「' + esc(r.productField) + '」 · ' +
          esc(typeText(r)) + '</span></div></li>';
      }).join('') : '<li><span style="color:var(--muted)">未定义硬约束</span></li>';
    }
    var s = $('ruleScores');
    if (s) {
      var sr = RULES.score_rules || [];
      s.innerHTML = sr.length ? sr.map(function (r) {
        return '<li><span class="w">+' + (Number(r.weight) || 0) + '</span><span class="mt">' + esc(r.matchType) + '</span>' +
          '<div><b>' + esc(r.name || r.userField) + '</b><br>' +
          '<span style="color:var(--muted)">用户「' + esc(r.userField) + '」 → 产品「' + esc(r.productField) + '」</span></div></li>';
      }).join('') : '<li><span style="color:var(--muted)">未定义打分项</span></li>';
    }
  }

  /* ---------- 主流程 ---------- */
  function run(e) {
    if (e) e.preventDefault();
    var user = buildUser();
    var res = recommend(PRODUCTS, user, RULES);
    renderResult(user, res);
    var sec = $('result');
    if (sec && sec.scrollIntoView) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('已生成推荐 · 保留 ' + res.kept.length + ' 款');
  }

  function loadDemo(silent) {
    var u = DEMO;
    if (!u || !u['性别']) { toast('示例画像数据缺失'); return; }
    var set = function (id, v) { var el = $(id); if (el) el.value = v; };
    set('f_gender', u['性别'] || '男');
    set('f_age', u['年龄'] || 30);
    set('f_health', u['健康状况'] || '');
    set('f_budget', u['预算上限'] || 5000);
    set('f_weight', u['重量上限(g)'] || 600);
    set('f_season', u['季节/气候'] || '秋季');
    syncRanges();
    setChip('使用场景', u['使用场景']);
    setChip('天气', u['天气']);
    setChip('装备类型需求', u['装备类型需求']);
    setChip('防水需求', u['防水需求']);
    setChip('防风需求', u['防风需求']);
    setChip('保暖需求', u['保暖需求']);
    setChip('可拆内胆需求', u['可拆内胆需求']);
    var m = findMountain(u['目标山峰']);
    state.mountain = m; state.band = u['海拔档位']; state.diff = u['路线难度'];
    renderMountains();
    renderForecast();
    renderGearTip();
    if (!silent) toast('已载入示例画像 · ' + (u['目标山峰'] || ''));
  }

  function syncRanges() {
    var b = $('f_budget'), vb = $('v_budget');
    var w = $('f_weight'), vw = $('v_weight');
    if (b && vb) vb.textContent = '¥' + b.value;
    if (w && vw) vw.textContent = w.value + 'g';
  }

  function initHero() {
    var img = $('heroImg');
    if (!img) return;
    var prompt = 'editorial outdoor fashion photograph, a lone hiker wearing a technical shell jacket standing on a rocky alpine ridge at dawn, layered misty mountain ranges behind, muted sage green cream and teak color palette, soft natural light, minimalist wide composition, subtle film grain, high-end magazine editorial, no text';
    img.src = 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=' + encodeURIComponent(prompt) + '&image_size=landscape_16_9';
    img.onerror = function () { img.style.display = 'none'; };
  }

  function initReveal() {
    var els = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) {
      for (var i = 0; i < els.length; i++) els[i].classList.add('in');
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.12 });
    for (var k = 0; k < els.length; k++) io.observe(els[k]);
  }

  function init() {
    if (!PRODUCTS.length || !MOUNTAINS.length) {
      var hint = $('resultHint');
      if (hint) hint.textContent = '未检测到数据（assets/data.js）。请确认数据文件已生成。';
      return;
    }
    initChips();
    renderRegions();
    renderMountains();
    renderRules();
    renderGearTip();
    initHero();
    initReveal();

    var search = $('mtnSearch');
    if (search) search.addEventListener('input', renderMountains);
    var season = $('f_season');
    if (season) season.addEventListener('change', renderForecast);

    var grid = $('mtnGrid');
    if (grid) {
      grid.addEventListener('click', function (e) {
        var t = e.target.closest('.mtn-card');
        if (!t) return;
        prefillFromMountain(findMountain(t.getAttribute('data-name')));
      });
    }

    var pre = $('btnPrefill');
    if (pre) pre.addEventListener('click', function () { prefillFromMountain(state.mountain); });
    var demo = $('btnDemo');
    if (demo) demo.addEventListener('click', function () { loadDemo(false); });
    var runBtn = $('btnRun');
    if (runBtn) runBtn.addEventListener('click', run);

    var b = $('f_budget'), w = $('f_weight');
    if (b) b.addEventListener('input', syncRanges);
    if (w) w.addEventListener('input', syncRanges);

    /* 首屏：按示例画像带出条件并直接给出结果；健康状况保持默认「无特殊健康状况」 */
    loadDemo(true);
    var health = $('f_health');
    if (health) health.value = '';
    syncRanges();
    renderResult(buildUser(), recommend(PRODUCTS, buildUser(), RULES));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
