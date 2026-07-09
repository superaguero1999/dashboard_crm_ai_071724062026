const SaleOutRenderer = (() => {
  let _saleoutData = [];
  let _errorData   = [];
  let _filters     = { months: [], shortNames: [] };
  let _activeSubTab = 'rate';
  let _soSearchQueries = { month: '', product: '' };
  let _tableRendered = false;
  let _chartProduct = null;
  let _chartMonth   = null;
  let _productTopN  = 20;
  let _productOrder = 'desc';
  let _isLoading    = false;
  let _extraFilters = [];   // [{id, field, selectedValues}]
  let _efSearchQueries = {};
  let _namespace = 'spm1'; // track namespace riêng để tránh race condition
  let _ecnMap = {};         // {model_code: {applied_month: [ecn_records]}}

  function setNamespace(ns) { _namespace = ns; }

  function setEcnMap(map) { _ecnMap = map || {}; }

  // ── ECN highlight helpers ─────────────────────────────────────────────────
  function _ecnCoverage(modelCode, cellMonth) {
    const byMonth = _ecnMap[modelCode] || {};
    const cellNum = ErrorRateService.monthToNum(cellMonth);

    // Tìm applied_month mới nhất có window 12 tháng cover cell này
    let latestCoveringStart = 0;
    for (const [m, ecns] of Object.entries(byMonth)) {
      if (!ecns.length) continue;
      const start = ErrorRateService.monthToNum(m);
      if (cellNum >= start && cellNum < start + 12 && start > latestCoveringStart) {
        latestCoveringStart = start;
      }
    }
    if (latestCoveringStart === 0) return 0;

    // Rank = số ECN applied_month <= latestCoveringStart
    // → ECN mới hơn = rank cao hơn = màu đậm hơn; toàn bộ 12 tháng sau ECN đó đều cùng rank
    const allStarts = Object.entries(byMonth)
      .filter(([, ecns]) => ecns.length > 0)
      .map(([m]) => ErrorRateService.monthToNum(m))
      .sort((a, b) => a - b);
    return allStarts.filter(n => n <= latestCoveringStart).length;
  }

  function _ecnBgClass(count) {
    if (!count) return '';
    if (count === 1) return 'ecn-hl-1';
    if (count === 2) return 'ecn-hl-2';
    if (count <= 4)  return 'ecn-hl-3';
    return 'ecn-hl-4';
  }

  function _hasEcnStart(modelCode, month) {
    return !!(_ecnMap[modelCode]?.[month]?.length);
  }

  const COLORS = APP_CONFIG ? APP_CONFIG.chartColors : [
    '#3B82F6','#EF4444','#10B981','#F59E0B','#8B5CF6',
    '#06B6D4','#EC4899','#84CC16','#F97316','#6366F1',
  ];

  const _EF_PALETTE = [
    { h: '#7C3AED', b: '#8B5CF6', bg: '#F5F3FF' },
    { h: '#0891B2', b: '#06B6D4', bg: '#ECFEFF' },
    { h: '#DB2777', b: '#EC4899', bg: '#FDF2F8' },
    { h: '#D97706', b: '#F59E0B', bg: '#FFFBEB' },
    { h: '#E11D48', b: '#F43F5E', bg: '#FFF1F2' },
    { h: '#65A30D', b: '#84CC16', bg: '#F7FEE7' },
  ];

  function _el(id) { return document.getElementById(id); }

  // ── Loading helpers ──────────────────────────────────────────────────────
  function _spinnerHtml(size) {
    const sz = size === 'sm' ? 'w-5 h-5' : 'w-8 h-8';
    const py = size === 'sm' ? 'py-6'    : 'py-16';
    return `<div class="flex flex-col items-center justify-center ${py} gap-2 text-gray-400">
      <svg class="${sz} animate-spin text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 22 6.477 22 12h-4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
      </svg>
      <p class="text-xs text-blue-400">Đang tải dữ liệu...</p>
    </div>`;
  }

  function _showChartLoader(wrapId) {
    const wrap = _el(wrapId);
    if (!wrap) return;
    wrap.querySelectorAll('.so-chart-overlay').forEach(e => e.remove());
    const ov = document.createElement('div');
    ov.className = 'so-chart-overlay absolute inset-0 flex flex-col items-center justify-center bg-white/80 z-10 gap-2';
    ov.innerHTML = `<svg class="w-8 h-8 animate-spin text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 22 6.477 22 12h-4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
    </svg>
    <p class="text-xs text-blue-400">Đang tải biểu đồ...</p>`;
    wrap.appendChild(ov);
  }

  function _hideChartLoader(wrapId) {
    const wrap = _el(wrapId);
    if (!wrap) return;
    wrap.querySelectorAll('.so-chart-overlay').forEach(e => e.remove());
  }

  // ── Sub-tab switching ────────────────────────────────────────────────────
  function _activateSubTab(which) {
    // Nếu đang ở pivot/dashboard, switch về saleout section trước
    const saleoutSection = _el('saleout-section');
    if (saleoutSection && saleoutSection.style.display === 'none') {
      if (window._mainActivateTab) window._mainActivateTab('saleout');
    }

    _activeSubTab = which;
    const dataEl = _el('saleout-data-subsection');
    const rateEl = _el('saleout-rate-subsection');

    if (dataEl) dataEl.style.display = which === 'data' ? '' : 'none';
    if (rateEl) rateEl.style.display = which === 'rate' ? '' : 'none';

    // Cập nhật active styling trên tất cả 4 sub-tab
    const activeId = which === 'data' ? 'subtab-saleout-data' : 'subtab-saleout-rate';
    if (window._setSubTabActive) {
      window._setSubTabActive(activeId);
    }

    if (which === 'rate') _renderRateSection();
    if (which === 'data' && !_tableRendered) _renderSaleOutTable();
  }

  // ── Sidebar filter (pill buttons — Tháng / SP + extra filters) ───────────
  function renderSidebar() {
    const container = _el('saleout-sidebar-content');
    if (!container) return;

    if (_isLoading) {
      container.innerHTML = `<div class="flex flex-col items-center py-6 gap-2">
        <svg class="w-5 h-5 animate-spin text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 22 6.477 22 12h-4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
        </svg>
        <p class="text-xs text-blue-400 text-center">Đang tải...</p>
      </div>`;
      return;
    }

    if (_saleoutData.length === 0) {
      container.innerHTML = '<p class="text-xs text-gray-400 italic p-2">Chưa có dữ liệu Sale Out</p>';
      return;
    }

    const allMonths   = ErrorRateService.getUniqueMonths(_saleoutData);
    const allProducts = ErrorRateService.getUniqueProducts(_saleoutData);

    // Lưu search query hiện tại trước khi rebuild HTML
    const monthSearchEl   = container.querySelector('.so-search[data-type="month"]');
    const productSearchEl = container.querySelector('.so-search[data-type="product"]');
    if (monthSearchEl)   _soSearchQueries.month   = monthSearchEl.value;
    if (productSearchEl) _soSearchQueries.product = productSearchEl.value;
    container.querySelectorAll('.so-ef-search').forEach(input => {
      _efSearchQueries[input.dataset.efid] = input.value;
    });

    // Màu cho bộ lọc cố định
    const _SC = {
      month:   { h: '#2563EB', b: '#3B82F6', bg: '#EFF6FF' },
      product: { h: '#059669', b: '#10B981', bg: '#ECFDF5' },
    };

    function _pill(type, value) {
      const pc = _SC[type] || _SC.month;
      const active = _filters[type === 'month' ? 'months' : 'shortNames'];
      const isActive = active.length === 0 || active.includes(value);
      const activeStyle = `background:${pc.h};color:white;border-color:${pc.h}`;
      const inactiveStyle = 'background:white;color:#6B7280;border-color:#E5E7EB';
      return `<button class="so-pill text-xs px-1.5 py-0.5 rounded border transition-colors"
                style="${isActive ? activeStyle : inactiveStyle}"
                data-type="${type}" data-value="${value.replace(/"/g,'&quot;')}">${value}</button>`;
    }

    function _filterCard(type, title, pillsId, searchVal, pills) {
      const pc = _SC[type];
      return `
        <div class="rounded-xl mb-3 overflow-hidden shadow-sm" style="border:2px solid ${pc.b};background:${pc.bg}">
          <div class="flex items-center justify-between px-3 py-2" style="background:${pc.h}">
            <span class="font-bold text-white text-sm tracking-wide">${title}</span>
            <button class="so-clear text-white/70 hover:text-white text-xs font-semibold transition-colors" data-type="${type}">Tất cả</button>
          </div>
          <div class="px-2 pt-2 pb-1">
            <input type="text" class="so-search w-full text-xs rounded px-2 py-1 mb-1.5 outline-none bg-white placeholder-gray-300"
                   style="border:1.5px solid ${pc.b}80"
                   data-type="${type}" placeholder="🔍 Tìm..." value="${searchVal.replace(/"/g,'&quot;')}">
            <div id="${pillsId}" class="flex flex-wrap gap-1 max-h-44 overflow-y-auto">
              ${pills}
            </div>
          </div>
        </div>`;
    }

    // Extra filter cards
    const extraHtml = _extraFilters.map((ef, idx) => {
      const p = _EF_PALETTE[idx % _EF_PALETTE.length];
      const fieldDef = APP_CONFIG.fieldDefinitions.find(f => f.key === ef.field);
      const label = fieldDef ? fieldDef.label : ef.field;
      const uniqueVals = [...new Set(_errorData.map(r => String(r[ef.field] ?? '')).filter(Boolean))].sort();
      const searchVal = (_efSearchQueries[ef.id] || '');
      const pills = uniqueVals.map(v => {
        const isActive = ef.selectedValues.length === 0 || ef.selectedValues.includes(v);
        const escaped = v.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
        const activeStyle = `background:${p.h};color:white;border-color:${p.h}`;
        const inactiveStyle = 'background:white;color:#6B7280;border-color:#E5E7EB';
        return `<button class="so-ef-pill text-xs px-1.5 py-0.5 rounded border transition-colors"
                  style="${isActive ? activeStyle : inactiveStyle}"
                  data-efid="${ef.id}" data-val="${escaped}">${v||'(trống)'}</button>`;
      }).join('');
      return `
        <div class="so-ef-card rounded-xl mb-3 overflow-hidden shadow-sm"
             style="border:2px solid ${p.b};background:${p.bg}" data-efid="${ef.id}">
          <div class="flex items-center justify-between px-3 py-2" style="background:${p.h}">
            <span class="font-bold text-white text-sm tracking-wide truncate">${label}</span>
            ${AuthService.isEditor() ? `<button class="so-ef-del text-white/60 hover:text-white ml-2 flex-shrink-0 text-base font-bold leading-none" data-efid="${ef.id}">✕</button>` : ''}
          </div>
          <div class="px-2 pt-2 pb-1">
            <input type="text" class="so-ef-search w-full text-xs rounded px-2 py-1 mb-1.5 outline-none bg-white placeholder-gray-300"
                   style="border:1.5px solid ${p.b}80"
                   data-efid="${ef.id}" placeholder="🔍 Tìm..." value="${searchVal.replace(/"/g,'&quot;')}">
            <div class="so-ef-pills flex flex-wrap gap-1 max-h-36 overflow-y-auto" data-efid="${ef.id}">
              ${uniqueVals.length === 0
                ? `<span class="text-gray-300 italic">Không có dữ liệu</span>`
                : pills}
            </div>
            ${ef.selectedValues.length
              ? `<button class="so-ef-clear font-semibold mt-1 block text-xs transition-colors" style="color:${p.h}" data-efid="${ef.id}">✕ Bỏ lọc</button>`
              : ''}
          </div>
        </div>`;
    }).join('');

    container.innerHTML =
      _filterCard('month',   'Tháng',    'so-month-pills',   _soSearchQueries.month,   allMonths.map(m => _pill('month', m)).join('')) +
      _filterCard('product', 'Sản phẩm', 'so-product-pills', _soSearchQueries.product, allProducts.map(p => _pill('product', p)).join('')) +
      extraHtml;

    // ── Bind fixed filter events ──
    container.querySelectorAll('.so-pill').forEach(btn => {
      btn.addEventListener('click', () => _togglePill(btn.dataset.type, btn.dataset.value));
    });

    container.querySelectorAll('.so-clear').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.type === 'month') _filters.months = [];
        else _filters.shortNames = [];
        renderSidebar();
        _onFilterApply();
      });
    });

    container.querySelectorAll('.so-search').forEach(input => {
      function applyFilter() {
        const q = input.value.toLowerCase().trim();
        const pillsEl = input.dataset.type === 'month' ? _el('so-month-pills') : _el('so-product-pills');
        if (!pillsEl) return;
        pillsEl.querySelectorAll('.so-pill').forEach(btn => {
          btn.style.display = !q || btn.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      }
      applyFilter();
      input.addEventListener('input', () => {
        _soSearchQueries[input.dataset.type] = input.value;
        applyFilter();
      });
    });

    // ── Bind extra filter events ──
    container.querySelectorAll('.so-ef-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.efid;
        _extraFilters = _extraFilters.filter(ef => ef.id !== id);
        delete _efSearchQueries[id];
        _saveExtraFilters();
        renderSidebar();
        _onFilterApply();
      });
    });

    container.querySelectorAll('.so-ef-pill').forEach(btn => {
      btn.addEventListener('click', () => _toggleExtraPill(btn.dataset.efid, btn.dataset.val));
    });

    container.querySelectorAll('.so-ef-clear').forEach(btn => {
      btn.addEventListener('click', () => {
        const ef = _extraFilters.find(f => f.id === btn.dataset.efid);
        if (ef) { ef.selectedValues = []; _saveExtraFilters(); }
        renderSidebar();
        _onFilterApply();
      });
    });

    container.querySelectorAll('.so-ef-search').forEach(input => {
      function applyEfFilter() {
        const q = input.value.toLowerCase().trim();
        const wrap = container.querySelector(`.so-ef-pills[data-efid="${input.dataset.efid}"]`);
        if (!wrap) return;
        wrap.querySelectorAll('.so-ef-pill').forEach(btn => {
          btn.style.display = !q || btn.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      }
      applyEfFilter();
      input.addEventListener('input', () => {
        _efSearchQueries[input.dataset.efid] = input.value;
        applyEfFilter();
      });
    });
  }

  // Toggle pill: [] = tất cả active; có giá trị = chỉ hiện giá trị đó
  function _togglePill(type, value) {
    const isMonth = type === 'month';
    const current = isMonth ? _filters.months : _filters.shortNames;
    const all     = isMonth ? ErrorRateService.getUniqueMonths(_saleoutData)
                            : ErrorRateService.getUniqueProducts(_saleoutData);
    let next;
    if (current.length === 0) {
      next = [value];
    } else {
      const idx = current.indexOf(value);
      next = idx === -1 ? [...current, value]
                        : current.filter(v => v !== value);
      if (next.length === 0 || next.length === all.length) next = [];
    }
    if (isMonth) _filters.months = next;
    else _filters.shortNames = next;

    // Lưu scroll trước khi rebuild
    const savedScrolls = {
      months:   (_el('so-month-pills')?.scrollTop)           || 0,
      products: (_el('so-product-pills')?.scrollTop)         || 0,
      data:     (_el('saleout-data-subsection')?.scrollTop)  || 0,
      rate:     (_el('saleout-rate-subsection')?.scrollTop)  || 0,
    };

    renderSidebar();
    _onFilterApply();

    // Phục hồi scroll sau khi DOM cập nhật xong
    requestAnimationFrame(() => {
      const nm = _el('so-month-pills');
      const np = _el('so-product-pills');
      const ds = _el('saleout-data-subsection');
      const rs = _el('saleout-rate-subsection');
      if (nm) nm.scrollTop = savedScrolls.months;
      if (np) np.scrollTop = savedScrolls.products;
      if (ds) ds.scrollTop = savedScrolls.data;
      if (rs) rs.scrollTop = savedScrolls.rate;
    });
  }

  function _onFilterApply() {
    _tableRendered = false;
    if (_activeSubTab === 'rate') _renderRateSection();
    if (_activeSubTab === 'data') _renderSaleOutTable();
  }

  // ── Shared helpers ───────────────────────────────────────────────────────
  function _rateBg(r)  { if (r===null) return ''; if (r>=5) return 'bg-red-100'; if (r>=2) return 'bg-amber-100'; if (r>0) return 'bg-green-50'; return ''; }
  function _rateTxt(r) { if (r===null) return 'text-gray-300'; if (r>=5) return 'text-red-700 font-bold'; if (r>=2) return 'text-amber-700 font-semibold'; if (r>0) return 'text-emerald-700'; return 'text-gray-400'; }
  function _avg(arr)   { const v = arr.filter(x => x !== null); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : null; }

  // borderColor, headerBg, label, badge : giống cũ
  // summaryRowHtml : <tr> của hàng tổng (cũ là tfoot) — sẽ đặt giữa tiêu đề và header
  // colHeaderRowHtml : <tr> của hàng tiêu đề cột
  // tbodyHtml       : nội dung <tbody>
  function _tableWrap(borderColor, headerBg, label, badge, summaryRowHtml, colHeaderRowHtml, tbodyHtml) {
    return `<div class="so-table-wrap rounded-xl border ${borderColor} shadow-sm mb-4 overflow-hidden">
      <!-- Tiêu đề nằm NGOÀI vùng overflow: không bị cuộn ngang -->
      <div class="px-4 py-2.5 ${headerBg} border-b flex items-center gap-2">
        <span class="text-xs font-bold uppercase tracking-wide">${label}</span>
        ${badge ? `<span class="text-xs opacity-70">${badge}</span>` : ''}
      </div>
      <!-- Vùng cuộn chỉ chứa bảng -->
      <div style="overflow:auto;max-height:285px">
        <table class="w-full text-sm border-collapse bg-white">
          <colgroup>
            <col style="width:100px;min-width:100px">
            <col style="width:140px;min-width:140px">
            <col style="width:120px;min-width:120px">
            <col style="width:90px;min-width:90px">
          </colgroup>
          <thead style="position:sticky;top:0;z-index:20">
            ${summaryRowHtml}
            ${colHeaderRowHtml}
          </thead>
          <tbody>${tbodyHtml}</tbody>
        </table>
      </div>
    </div>`;
  }

  // Trả về <tr> (không bọc <thead> — _tableWrap lo phần đó)
  // 4 cột đầu sticky: left 0 / 100 / 240 / 360  (khớp với colgroup widths 100+140+120+90)
  function _thRow(cols, lastLabel, accentBg, accentDark) {
    return `<tr class="${accentBg} text-white text-xs">
      <th class="px-3 py-2 text-left sticky left-0      ${accentBg} z-[25] whitespace-nowrap">Mã SP</th>
      <th class="px-3 py-2 text-left sticky left-[100px] ${accentBg} z-[25] whitespace-nowrap">Tên SP</th>
      <th class="px-3 py-2 text-left sticky left-[240px] ${accentBg} z-[25] whitespace-nowrap">Tên rút gọn</th>
      <th class="px-3 py-2 text-right font-bold sticky left-[360px] ${accentDark} z-[25] whitespace-nowrap border-r border-white/30">${lastLabel}</th>
      ${cols.map(c=>`<th class="px-3 py-2 text-right whitespace-nowrap">${c}</th>`).join('')}
    </tr>`;
  }

  function _infoTds(info, sn, rowBg) {
    return `<td class="px-3 py-1.5 text-xs text-gray-600 sticky left-0       ${rowBg} z-[10] font-mono whitespace-nowrap overflow-hidden">${info.model_code||'—'}</td>
            <td class="px-3 py-1.5 text-xs text-gray-700 sticky left-[100px] ${rowBg} z-[10] whitespace-nowrap truncate" title="${info.product_fullname}">${info.product_fullname||'—'}</td>
            <td class="px-3 py-1.5 text-xs font-medium text-gray-800 sticky left-[240px] ${rowBg} z-[10] whitespace-nowrap truncate" title="${sn}">${sn}</td>`;
  }

  // ── Bộ lọc dùng chung ────────────────────────────────────────────────────
  function _applyFilters() {
    const norm = s => ErrorRateService.normName(s);
    let fe = _errorData, fs = _saleoutData;
    if (_filters.months.length > 0) {
      const mSet = new Set(_filters.months);
      fe = fe.filter(r => mSet.has(r.month));
      fs = fs.filter(r => mSet.has(r.month));
    }
    if (_filters.shortNames.length > 0) {
      const nSet = new Set(_filters.shortNames.map(norm));
      fe = fe.filter(r => nSet.has(norm(r.product_shortname)));
      fs = fs.filter(r => nSet.has(norm(r.short_name)));
    }
    for (const ef of _extraFilters) {
      if (ef.selectedValues.length > 0) {
        const vSet = new Set(ef.selectedValues);
        fe = fe.filter(r => vSet.has(String(r[ef.field] ?? '')));
      }
    }
    return { fe, fs };
  }

  // Chỉ áp dụng extra filters (dùng cho TLL rate section — ErrorRateService sẽ tự apply months/shortNames)
  function _applyExtraFiltersOnly(errors) {
    let fe = errors;
    for (const ef of _extraFilters) {
      if (ef.selectedValues.length > 0) {
        const vSet = new Set(ef.selectedValues);
        fe = fe.filter(r => vSet.has(String(r[ef.field] ?? '')));
      }
    }
    return fe;
  }

  // ── Điều phối chính ───────────────────────────────────────────────────────
  function _renderSaleOutTable() {
    const container = _el('saleout-table-container');
    if (!container) return;

    if (_isLoading) { container.innerHTML = _spinnerHtml('lg'); return; }

    if (_saleoutData.length === 0) {
      container.innerHTML = `<div class="flex flex-col items-center justify-center py-16 text-gray-400">
        <svg class="w-12 h-12 mb-3 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 10h18M3 6h18M3 14h18M3 18h18"/>
        </svg>
        <p class="text-sm">Chưa có dữ liệu Sale Out</p>
        <p class="text-xs mt-1 text-gray-300">Nhấn "Import Sale Out" để bắt đầu</p>
      </div>`;
      return;
    }

    const { fe, fs } = _applyFilters();

    // Build shared product list & month list từ filtered saleout
    const productMap = new Map();
    for (const r of fs) {
      if (!productMap.has(r.short_name))
        productMap.set(r.short_name, { model_code: r.model_code||'', product_fullname: r.product_fullname||'' });
    }
    const months   = ErrorRateService.getUniqueMonths(fs);
    const products = [...productMap.entries()];

    const filterNote = (_filters.months.length || _filters.shortNames.length)
      ? `<p class="text-xs text-amber-600 mb-2">⚑ Đang lọc: ${[
          _filters.months.length ? _filters.months.length+' tháng' : '',
          _filters.shortNames.length ? _filters.shortNames.length+' sản phẩm' : '',
        ].filter(Boolean).join(', ')}</p>`
      : '';

    // Thứ tự: Tỷ lệ % → Số lượng lỗi → Sale Out
    container.innerHTML =
      filterNote +
      _tllMatrixHtml(products, months, fs, fe) +
      _errCountMatrixHtml(products, months, fe) +
      _saleOutMatrixHtml(products, months, fs);
    _tableRendered = true;
  }

  // ── Bảng 1: Tỷ lệ lỗi % (LŨY KẾ) ───────────────────────────────────────
  function _tllMatrixHtml(products, months, fs, fe) {
    const norm = s => ErrorRateService.normName(s);
    const saleMap = new Map();
    for (const r of fs) saleMap.set(`${norm(r.short_name)}|${r.month}`, Number(r.value)||0);
    const errMap  = new Map();
    for (const r of fe) { const k=`${norm(r.product_shortname)}|${r.month}`; errMap.set(k,(errMap.get(k)||0)+1); }

    function cumulRate(sn, upToIdx) {
      const nsn = norm(sn);
      const currentSale = saleMap.get(`${nsn}|${months[upToIdx]}`) || 0;
      if (currentSale === 0) return null;
      let totalSale = 0, totalErr = 0;
      for (let i = 0; i <= upToIdx; i++) {
        const m = months[i];
        totalSale += saleMap.get(`${nsn}|${m}`) || 0;
        totalErr  += errMap.get(`${nsn}|${m}`) || 0;
      }
      return totalSale > 0 ? (totalErr / totalSale * 100) : null;
    }

    function cumulColRate(upToIdx) {
      const hasCurrentSale = products.some(([sn]) => (saleMap.get(`${norm(sn)}|${months[upToIdx]}`) || 0) > 0);
      if (!hasCurrentSale) return null;
      let totalSale = 0, totalErr = 0;
      for (let i = 0; i <= upToIdx; i++) {
        const m = months[i];
        for (const [sn] of products) {
          totalSale += saleMap.get(`${norm(sn)}|${m}`) || 0;
          totalErr  += errMap.get(`${norm(sn)}|${m}`) || 0;
        }
      }
      return totalSale > 0 ? (totalErr / totalSale * 100) : null;
    }

    const fmtR = r => r===null ? '—' : r.toFixed(2)+'%';

    const colRates  = months.map((_m, idx) => cumulColRate(idx));
    const grandTotal = cumulColRate(months.length - 1);
    const summaryRow = `<tr class="bg-rose-100 border-b-2 border-rose-300">
      <td colspan="3" class="px-3 py-2 text-xs font-bold text-rose-900 sticky left-0 z-[15] bg-rose-100 whitespace-nowrap">% lỗi theo tháng (LK)</td>
      <td class="px-3 py-2 text-right text-xs font-bold sticky left-[360px] z-[15] bg-rose-200 ${_rateTxt(grandTotal)} border-r-2 border-rose-300">${fmtR(grandTotal)}</td>
      ${colRates.map(r=>`<td class="px-3 py-2 text-right text-xs font-bold ${_rateBg(r)||'bg-rose-50'} ${_rateTxt(r)}">${fmtR(r)}</td>`).join('')}
    </tr>`;
    const colHeaderRow = _thRow(months, '% lỗi theo model', 'bg-rose-700', 'bg-rose-800');

    const rows = products.map(([sn,info],ri) => {
      const rowRates = months.map((_m, idx) => cumulRate(sn, idx));
      const rowTotal = cumulRate(sn, months.length - 1);
      const rowBg    = ri%2===0 ? 'bg-white' : 'bg-gray-50';
      return `<tr class="${rowBg} hover:bg-rose-50 transition-colors">
        ${_infoTds(info,sn,rowBg)}
        <td class="px-3 py-1.5 text-right text-xs font-bold sticky left-[360px] z-[10] ${_rateBg(rowTotal)||rowBg} ${_rateTxt(rowTotal)} border-r border-rose-200">${fmtR(rowTotal)}</td>
        ${rowRates.map(r=>`<td class="px-3 py-1.5 text-right text-xs ${_rateBg(r)} ${_rateTxt(r)}">${fmtR(r)}</td>`).join('')}
      </tr>`;
    }).join('');

    return _tableWrap('border-rose-200','bg-rose-50',
      `<span class="text-rose-700">📉 Tỷ lệ lỗi lũy kế (Lỗi ÷ ${_namespace === 'spm2' ? 'Sale In' : 'Sale Out'})</span>`,
      '— màu: <span class="text-red-600 font-bold">≥5%</span> · <span class="text-amber-600">≥2%</span> · <span class="text-emerald-600">&lt;2%</span>',
      summaryRow, colHeaderRow, rows);
  }

  // ── Bảng 2: Số lượng lỗi ────────────────────────────────────────────────
  function _errCountMatrixHtml(products, months, fe) {
    const norm = s => ErrorRateService.normName(s);
    const saleProds = new Set(products.map(([sn]) => norm(sn)));

    const errMap = new Map();
    for (const r of fe) { const k=`${norm(r.product_shortname)}|${r.month}`; errMap.set(k,(errMap.get(k)||0)+1); }
    const cnt = (sn,m) => errMap.get(`${norm(sn)}|${m}`) || 0;

    // Đếm lỗi không khớp tên SP với Sale Out
    const unmatchedByMonth = new Map();
    let unmatchedTotal = 0;
    for (const r of fe) {
      const pNorm = norm(r.product_shortname);
      if (!pNorm || !saleProds.has(pNorm)) {
        unmatchedTotal++;
        const m = r.month || '';
        unmatchedByMonth.set(m, (unmatchedByMonth.get(m) || 0) + 1);
      }
    }

    // Tìm max để scale màu
    let maxV = 0;
    for (const [sn] of products) for (const m of months) maxV = Math.max(maxV, cnt(sn,m));

    const cntBg = v => { if (!v) return ''; const r=v/Math.max(maxV,1); if (r>0.6) return 'bg-orange-200'; if (r>0.3) return 'bg-orange-100'; return 'bg-orange-50'; };

    const colTotals   = months.map(m => products.reduce((s,[sn])=>s+cnt(sn,m),0));
    const matchedTotal = colTotals.reduce((a,b)=>a+b,0);
    const grandTotal  = matchedTotal + unmatchedTotal;

    const summaryRow = `<tr class="bg-orange-100 border-b-2 border-orange-300">
      <td colspan="3" class="px-3 py-2 text-xs font-bold text-orange-900 sticky left-0 z-[15] bg-orange-100 whitespace-nowrap">Tổng lỗi theo tháng</td>
      <td class="px-3 py-2 text-right text-xs font-bold sticky left-[360px] z-[15] text-orange-900 bg-orange-200 border-r-2 border-orange-300">${grandTotal||'—'}</td>
      ${colTotals.map(v=>`<td class="px-3 py-2 text-right text-xs font-bold text-orange-800 bg-orange-50">${v||'—'}</td>`).join('')}
    </tr>`;
    const colHeaderRow = _thRow(months, 'Tổng lỗi theo model', 'bg-orange-600', 'bg-orange-700');

    const rows = products.map(([sn,info],ri) => {
      const vals = months.map(m => cnt(sn,m));
      const rowTotal = vals.reduce((a,v)=>a+v, 0);
      const cells = vals.map(v=>`<td class="px-3 py-1.5 text-right text-xs ${v?cntBg(v):''} ${v?'text-orange-800':'text-gray-300'}">${v||'—'}</td>`).join('');
      const rowBg = ri%2===0 ? 'bg-white' : 'bg-gray-50';
      return `<tr class="${rowBg} hover:bg-orange-50 transition-colors">
        ${_infoTds(info,sn,rowBg)}
        <td class="px-3 py-1.5 text-right text-xs font-bold sticky left-[360px] z-[10] ${rowBg} text-orange-700 border-r border-orange-200">${rowTotal||'—'}</td>
        ${cells}
      </tr>`;
    }).join('');

    // Hàng lỗi không khớp tên SP với Sale Out
    const unmatchedRow = unmatchedTotal > 0 ? `
      <tr class="bg-yellow-50 border-t-2 border-yellow-300 hover:bg-yellow-100 transition-colors">
        <td class="px-3 py-1.5 text-xs text-yellow-700 sticky left-0 bg-yellow-50 z-[10] font-mono whitespace-nowrap">—</td>
        <td class="px-3 py-1.5 text-xs text-yellow-800 italic sticky left-[100px] bg-yellow-50 z-[10] whitespace-nowrap truncate" title="Lỗi không tìm thấy tên SP tương ứng trong Sale Out">⚠️ Không khớp Sale Out</td>
        <td class="px-3 py-1.5 text-xs text-yellow-700 sticky left-[240px] bg-yellow-50 z-[10] whitespace-nowrap">—</td>
        <td class="px-3 py-1.5 text-right text-xs font-bold sticky left-[360px] z-[10] bg-yellow-100 text-yellow-800 border-r border-yellow-300">${unmatchedTotal}</td>
        ${months.map(m => { const v = unmatchedByMonth.get(m)||0; return `<td class="px-3 py-1.5 text-right text-xs ${v?'text-yellow-700':'text-gray-300'}">${v||'—'}</td>`; }).join('')}
      </tr>` : '';

    return _tableWrap('border-orange-200','bg-orange-50',
      '<span class="text-orange-700">🔢 Số lượng lỗi</span>',
      '— màu đậm = nhiều lỗi hơn',
      summaryRow, colHeaderRow, rows + unmatchedRow);
  }

  // ── Bảng 3: Dữ liệu Sale Out ─────────────────────────────────────────────
  function _saleOutMatrixHtml(products, months, filtered) {
    const valMap = new Map(filtered.map(r=>[`${r.short_name}|${r.month}`,Number(r.value)||0]));
    const colTotals = {}; months.forEach(m=>{colTotals[m]=0;}); let grandTotal=0;
    for (const r of filtered) { colTotals[r.month]=(colTotals[r.month]||0)+(Number(r.value)||0); grandTotal+=Number(r.value)||0; }
    const fmt = n => n.toLocaleString('vi-VN');

    const summaryRow = `<tr class="bg-amber-100 border-b-2 border-amber-300">
      <td colspan="3" class="px-3 py-2 text-xs font-bold text-amber-900 sticky left-0 z-[15] bg-amber-100 whitespace-nowrap">Tổng theo tháng</td>
      <td class="px-3 py-2 text-right text-xs font-bold sticky left-[360px] z-[15] text-amber-900 bg-amber-200 border-r-2 border-amber-300">${fmt(grandTotal)}</td>
      ${months.map(m=>`<td class="px-3 py-2 text-right text-xs font-bold text-amber-800 bg-amber-50">${fmt(colTotals[m]||0)}</td>`).join('')}
    </tr>`;
    const colHeaderRow = _thRow(months, 'Tổng theo model', 'bg-blue-600', 'bg-blue-700');

    const rows = products.map(([sn,info],ri) => {
      const mc = info.model_code || '';
      const vals = months.map(m=>valMap.get(`${sn}|${m}`)||0);
      const rowTotal = vals.reduce((a,v)=>a+v, 0);
      const cells = months.map((m, idx) => {
        const v        = vals[idx];
        const coverage = _ecnCoverage(mc, m);
        const bgClass  = _ecnBgClass(coverage);
        const hasStart = _hasEcnStart(mc, m);
        const dot      = hasStart
          ? `<span class="ecn-dot" data-ecn="${mc}|${m}" title="Có ECN áp dụng tại tháng này — Click để xem chi tiết"></span>`
          : '';
        return `<td class="px-3 py-1.5 text-right text-xs text-gray-700 ${bgClass}" style="position:relative">${dot}${v?fmt(v):'—'}</td>`;
      }).join('');
      const rowBg = ri%2===0 ? 'bg-white' : 'bg-gray-50';
      return `<tr class="${rowBg} hover:bg-blue-50 transition-colors">
        ${_infoTds(info,sn,rowBg)}
        <td class="px-3 py-1.5 text-right text-xs font-bold sticky left-[360px] z-[10] ${rowBg} text-blue-700 border-r border-blue-200">${fmt(rowTotal)}</td>
        ${cells}
      </tr>`;
    }).join('');

    return _tableWrap('border-blue-200','bg-blue-50',
      `<span class="text-blue-700">📦 Dữ liệu ${_namespace === 'spm2' ? 'Sale In' : 'Sale Out'}</span>`, '',
      summaryRow, colHeaderRow, rows);
  }

  // ── ECN detail popup (reuse drilldown-modal) ───────────────────────────────
  function _showEcnPopup(modelCode, month) {
    const ecns = _ecnMap[modelCode]?.[month] || [];
    const titleEl = document.getElementById('drilldown-title');
    const countEl = document.getElementById('drilldown-count');
    const tableEl = document.getElementById('drilldown-table-wrap');
    const modal   = document.getElementById('drilldown-modal');
    if (!modal) return;

    if (titleEl) titleEl.textContent = `ECN — Mã SP: ${modelCode} | Tháng áp dụng: ${month}`;
    if (countEl) countEl.textContent = `${ecns.length} ECN record${ecns.length !== 1 ? 's' : ''}`;

    if (tableEl) {
      if (!ecns.length) {
        tableEl.innerHTML = '<p class="p-6 text-sm text-gray-400 italic">Không có dữ liệu ECN.</p>';
      } else {
        tableEl.innerHTML = `
          <table class="w-full text-sm border-collapse">
            <thead class="bg-gray-50 sticky top-0">
              <tr>
                <th class="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 border-b">Mã ECN</th>
                <th class="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 border-b">Tên / Nội dung ECN</th>
                <th class="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 border-b">Tháng áp dụng</th>
                <th class="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 border-b">Thời gian áp dụng thực tế</th>
              </tr>
            </thead>
            <tbody>
              ${ecns.map((e, i) => `
                <tr class="${i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}">
                  <td class="px-4 py-2 text-xs font-semibold text-purple-700">${e.ecn_code || '—'}</td>
                  <td class="px-4 py-2 text-xs text-gray-700">${e.ecn_name || '—'}</td>
                  <td class="px-4 py-2 text-xs font-medium text-amber-700">${e.applied_month || '—'}</td>
                  <td class="px-4 py-2 text-xs text-gray-500">${e.actual_date || '—'}</td>
                </tr>`).join('')}
            </tbody>
          </table>`;
      }
    }

    // Ẩn nút Xuất Excel (không cần cho ECN popup)
    const exportBtn = document.getElementById('drilldown-export');
    if (exportBtn) exportBtn.style.display = 'none';

    modal.style.display = 'flex';
  }

  // ── Error rate tables ────────────────────────────────────────────────────
  function _renderRateSection() {
    _renderRateTables();
    _renderCharts();
  }

  function _renderRateTables() {
    if (_isLoading) {
      const pC = _el('rate-by-product-table');
      const mC = _el('rate-by-month-table');
      if (pC) pC.innerHTML = _spinnerHtml('sm');
      if (mC) mC.innerHTML = _spinnerHtml('sm');
      return { byProduct: [], byMonth: [] };
    }

    const _efFiltered = _applyExtraFiltersOnly(_errorData);
    const byProduct = ErrorRateService.calcByProduct(_efFiltered, _saleoutData, _filters);
    const byMonth   = ErrorRateService.calcByMonth(_efFiltered, _saleoutData, _filters);

    function _rateColor(rate) {
      if (rate === null) return 'text-gray-400';
      if (rate >= 5)  return 'text-red-600 font-bold';
      if (rate >= 2)  return 'text-amber-600 font-semibold';
      return 'text-emerald-600';
    }

    // Table by product — áp dụng cùng filter topN/order với biểu đồ
    const sortedProduct = [...byProduct].sort((a, b) =>
      _productOrder === 'asc' ? (a.rate || 0) - (b.rate || 0) : (b.rate || 0) - (a.rate || 0)
    );
    const displayedProduct = _productTopN > 0 ? sortedProduct.slice(0, _productTopN) : sortedProduct;

    const pContainer = _el('rate-by-product-table');
    if (pContainer) {
      if (displayedProduct.length === 0) {
        pContainer.innerHTML = '<p class="text-xs text-gray-400 italic text-center py-4">Không có dữ liệu</p>';
      } else {
        pContainer.innerHTML = `<table class="w-full text-xs border-collapse">
          <thead class="bg-gray-50 sticky top-0">
            <tr>
              <th class="px-2 py-1.5 text-left font-semibold text-gray-500 border-b">Tên rút gọn</th>
              <th class="px-2 py-1.5 text-right font-semibold text-gray-500 border-b">Lỗi</th>
              <th class="px-2 py-1.5 text-right font-semibold text-gray-500 border-b">${_namespace === 'spm2' ? 'Sale in' : 'Sale out'}</th>
              <th class="px-2 py-1.5 text-right font-semibold text-gray-500 border-b">TLL%</th>
            </tr>
          </thead>
          <tbody>
            ${displayedProduct.map((row, i) => `
              <tr class="${i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}">
                <td class="px-2 py-1 text-gray-700 font-medium whitespace-nowrap">${row.short_name}</td>
                <td class="px-2 py-1 text-right text-gray-600">${row.errors.toLocaleString('vi-VN')}</td>
                <td class="px-2 py-1 text-right text-gray-600">${row.sale.toLocaleString('vi-VN')}</td>
                <td class="px-2 py-1 text-right ${_rateColor(row.rate)}">${ErrorRateService.fmtRate(row.rate)}</td>
              </tr>`).join('')}
          </tbody>
        </table>`;
      }
    }

    // Table by month
    const mContainer = _el('rate-by-month-table');
    if (mContainer) {
      if (byMonth.length === 0) {
        mContainer.innerHTML = '<p class="text-xs text-gray-400 italic text-center py-4">Không có dữ liệu</p>';
      } else {
        mContainer.innerHTML = `<table class="w-full text-xs border-collapse">
          <thead class="bg-gray-50 sticky top-0">
            <tr>
              <th class="px-2 py-1.5 text-left font-semibold text-gray-500 border-b">Tháng</th>
              <th class="px-2 py-1.5 text-right font-semibold text-gray-500 border-b">Lỗi</th>
              <th class="px-2 py-1.5 text-right font-semibold text-gray-500 border-b">${_namespace === 'spm2' ? 'Sale in' : 'Sale out'}</th>
              <th class="px-2 py-1.5 text-right font-semibold text-gray-500 border-b" title="Lũy kế từ tháng đầu đến tháng này">TLL% (LK)</th>
            </tr>
          </thead>
          <tbody>
            ${byMonth.map((row, i) => `
              <tr class="${i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}">
                <td class="px-2 py-1 text-gray-700 font-medium">${row.month}</td>
                <td class="px-2 py-1 text-right text-gray-600">${row.errors.toLocaleString('vi-VN')}</td>
                <td class="px-2 py-1 text-right text-gray-600">${row.sale.toLocaleString('vi-VN')}</td>
                <td class="px-2 py-1 text-right ${_rateColor(row.rate)}">${ErrorRateService.fmtRate(row.rate)}</td>
              </tr>`).join('')}
          </tbody>
        </table>`;
      }
    }

    return { byProduct, byMonth };
  }

  // ── Charts ───────────────────────────────────────────────────────────────
  function _renderCharts() {
    const _efFiltered = _applyExtraFiltersOnly(_errorData);
    const byProduct = ErrorRateService.calcByProduct(_efFiltered, _saleoutData, _filters);
    const byMonth   = ErrorRateService.calcByMonth(_efFiltered, _saleoutData, _filters);

    if (_chartProduct) { _chartProduct.destroy(); _chartProduct = null; }
    if (_chartMonth)   { _chartMonth.destroy();   _chartMonth   = null; }

    if (_isLoading) {
      _showChartLoader('rate-by-product-chart-wrap');
      _showChartLoader('rate-by-month-chart-wrap');
      return;
    }
    _hideChartLoader('rate-by-product-chart-wrap');
    _hideChartLoader('rate-by-month-chart-wrap');

    const ctxP = _el('rate-by-product-chart');
    const ctxM = _el('rate-by-month-chart');

    // Sắp xếp theo order rồi cắt top-N
    const allSorted = [...byProduct].sort((a, b) =>
      _productOrder === 'asc'
        ? (a.rate || 0) - (b.rate || 0)
        : (b.rate || 0) - (a.rate || 0)
    );
    const displayed = _productTopN > 0 ? allSorted.slice(0, _productTopN) : allSorted;

    // Điều chỉnh chiều cao container theo số lượng items
    const wrap = _el('rate-by-product-chart-wrap');
    if (wrap) wrap.style.height = Math.max(200, displayed.length * 28 + 60) + 'px';

    if (ctxP && displayed.length > 0) {
      _chartProduct = new Chart(ctxP, {
        type: 'bar',
        data: {
          labels: displayed.map(r => r.short_name),
          datasets: [{
            label: 'Tỷ lệ lỗi (%)',
            data: displayed.map(r => r.rate !== null ? parseFloat(r.rate.toFixed(2)) : 0),
            backgroundColor: displayed.map((_, i) => COLORS[i % COLORS.length] + 'CC'),
            borderColor: displayed.map((_, i) => COLORS[i % COLORS.length]),
            borderWidth: 1,
          }],
        },
        options: {
          indexAxis: 'y',
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            datalabels: {
              anchor: 'end', align: 'end',
              formatter: v => v.toFixed(2) + '%',
              font: { size: 10 }, color: '#374151',
            },
          },
          scales: {
            x: { title: { display: true, text: 'TLL (%)', font: { size: 10 } } },
          },
        },
        plugins: typeof ChartDataLabels !== 'undefined' ? [ChartDataLabels] : [],
      });
    }

    if (ctxM && byMonth.length > 0) {
      _chartMonth = new Chart(ctxM, {
        type: 'line',
        data: {
          labels: byMonth.map(r => r.month),
          datasets: [{
            label: 'Tỷ lệ lỗi (%)',
            data: byMonth.map(r => r.rate !== null ? parseFloat(r.rate.toFixed(2)) : null),
            borderColor: '#3B82F6',
            backgroundColor: '#3B82F620',
            pointBackgroundColor: '#3B82F6',
            fill: true, tension: 0.3,
            spanGaps: false,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          layout: { padding: { top: 24 } },
          plugins: {
            legend: { display: false },
            datalabels: {
              formatter: v => v !== null ? v.toFixed(2) + '%' : '',
              font: { size: 9, weight: '600' },
              color: '#1D4ED8',
              anchor: 'top', align: 'top',
              offset: 4,
              clamp: true,
            },
          },
          scales: {
            y: {
              title: { display: true, text: 'TLL (%)', font: { size: 10 } },
              beginAtZero: true,
              grace: '5%',
              ticks: { callback: v => v + '%', font: { size: 10 } },
            },
          },
        },
        plugins: typeof ChartDataLabels !== 'undefined' ? [ChartDataLabels] : [],
      });
    }
  }

  // ── Extra filter helpers ─────────────────────────────────────────────────
  function _saveExtraFilters() {
    if (typeof DataService !== 'undefined' && DataService.saveSaleoutFilterData) {
      // Truyền _namespace tường minh để tránh race condition với background SPM2 load
      DataService.saveSaleoutFilterData([..._extraFilters], _namespace);
    }
  }

  function _toggleExtraPill(efId, value) {
    const ef = _extraFilters.find(f => f.id === efId);
    if (!ef) return;
    const allVals = [...new Set(_errorData.map(r => String(r[ef.field] ?? '')).filter(Boolean))];
    let next;
    if (ef.selectedValues.length === 0) {
      next = [value];
    } else {
      const idx = ef.selectedValues.indexOf(value);
      next = idx === -1 ? [...ef.selectedValues, value] : ef.selectedValues.filter(v => v !== value);
      if (next.length === 0 || next.length === allVals.length) next = [];
    }
    ef.selectedValues = next;
    _saveExtraFilters();

    const _sidebar   = _el('saleout-sidebar-content');
    const _pillsWrap = _sidebar?.querySelector(`.so-ef-pills[data-efid="${efId}"]`);
    const _savedSidebar = _sidebar?.scrollTop    || 0;
    const _savedPills   = _pillsWrap?.scrollTop  || 0;

    renderSidebar();
    _onFilterApply();

    requestAnimationFrame(() => {
      const ns = _el('saleout-sidebar-content');
      if (ns) ns.scrollTop = _savedSidebar;
      const np = ns?.querySelector(`.so-ef-pills[data-efid="${efId}"]`);
      if (np) np.scrollTop = _savedPills;
    });
  }

  function _renderAddSoFilterDropdown() {
    const fieldListEl = _el('add-so-filter-field-list');
    if (!fieldListEl) return;
    const existingFields = new Set(_extraFilters.map(ef => ef.field));
    const available = APP_CONFIG.fieldDefinitions.filter(f => {
      if (existingFields.has(f.key)) return false;
      if (f.key === 'month' || f.key === 'product_shortname') return false;
      return _errorData.some(r => r[f.key] !== undefined && r[f.key] !== null && r[f.key] !== '');
    });
    if (!available.length) {
      fieldListEl.innerHTML = `<p class="text-xs text-gray-400 px-3 py-2 italic">Đã thêm tất cả trường có dữ liệu</p>`;
      return;
    }
    fieldListEl.innerHTML = available.map(f => `
      <button class="add-so-filter-field w-full text-left text-xs px-3 py-2 hover:bg-blue-50 hover:text-blue-700
                     text-gray-700 transition-colors border-b border-gray-50 last:border-0"
              data-field="${f.key}">${f.label}</button>
    `).join('');
    fieldListEl.querySelectorAll('.add-so-filter-field').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        _extraFilters.push({ id: 'ef_' + Date.now(), field: btn.dataset.field, selectedValues: [] });
        _saveExtraFilters();
        const dd = _el('add-so-filter-dropdown');
        if (dd) dd.style.display = 'none';
        renderSidebar();
        _onFilterApply();
      });
    });
  }

  function getExtraFilters() { return _extraFilters; }

  function setExtraFilters(list) {
    _extraFilters = Array.isArray(list) ? list.map(ef => ({
      id: ef.id || ('ef_' + Date.now()),
      field: ef.field || '',
      selectedValues: Array.isArray(ef.selectedValues) ? ef.selectedValues : [],
    })).filter(ef => ef.field) : [];
    _efSearchQueries = {};
    _tableRendered = false;
  }

  // ── Public API ───────────────────────────────────────────────────────────
  function setData(saleoutData, errorData, { keepFilters = false } = {}) {
    _isLoading   = false;
    _saleoutData = saleoutData || [];
    _errorData   = errorData   || [];
    if (!keepFilters) _filters = { months: [], shortNames: [] };
    _tableRendered = false;
  }

  function setLoading(bool) {
    _isLoading = bool;
    renderSidebar();
    const soSection = _el('saleout-section');
    if (soSection && soSection.style.display !== 'none') {
      if (_activeSubTab === 'data') _renderSaleOutTable();
      else _renderRateSection();
    }
  }

  function render() {
    renderSidebar();
    if (_activeSubTab === 'data') {
      _renderSaleOutTable();
    } else {
      _renderRateSection();
    }
    const activeId = _activeSubTab === 'data' ? 'subtab-saleout-data' : 'subtab-saleout-rate';
    if (window._setSubTabActive) window._setSubTabActive(activeId);
  }

  function _downloadChart(chart, filename, titleText) {
    if (!chart) return;
    const src = chart.canvas;
    const headerH = titleText ? 36 : 0;
    const tmp = document.createElement('canvas');
    tmp.width  = src.width;
    tmp.height = src.height + headerH;
    const ctx2 = tmp.getContext('2d');
    ctx2.fillStyle = '#ffffff';
    ctx2.fillRect(0, 0, tmp.width, tmp.height);
    if (headerH) {
      ctx2.fillStyle = '#f1f5f9';
      ctx2.fillRect(0, 0, tmp.width, headerH);
      ctx2.strokeStyle = '#cbd5e1';
      ctx2.lineWidth = 1;
      ctx2.beginPath();
      ctx2.moveTo(0, headerH);
      ctx2.lineTo(tmp.width, headerH);
      ctx2.stroke();
      ctx2.fillStyle = '#1e3a5f';
      ctx2.font = 'bold 13px Arial, sans-serif';
      ctx2.textBaseline = 'middle';
      ctx2.fillText(titleText, 12, headerH / 2);
    }
    ctx2.drawImage(src, 0, headerH);
    const link = document.createElement('a');
    link.download = filename;
    link.href = tmp.toDataURL('image/png');
    link.click();
  }

  function init() {
    _el('subtab-saleout-data')?.addEventListener('click', () => _activateSubTab('data'));
    _el('subtab-saleout-rate')?.addEventListener('click', () => _activateSubTab('rate'));

    _el('btn-download-product-chart')?.addEventListener('click', () => {
      const orderLabel = _productOrder === 'asc' ? 'Thấp nhất' : 'Cao nhất';
      const topNLabel  = _productTopN > 0 ? `Top ${_productTopN}` : 'Tất cả';
      _downloadChart(_chartProduct, 'TLL_theo_san_pham.png', `Biểu đồ TLL theo sản phẩm  |  ${orderLabel}  |  ${topNLabel}`);
    });
    _el('btn-download-month-chart')?.addEventListener('click', () => {
      _downloadChart(_chartMonth, 'TLL_theo_thang.png', 'Biểu đồ TLL theo tháng');
    });

    function _syncProductControls() {
      const topnVal  = String(_productTopN);
      const orderVal = _productOrder;
      ['table-product-topn',  'chart-product-topn' ].forEach(id => { const el = _el(id); if (el) el.value = topnVal;  });
      ['table-product-order', 'chart-product-order'].forEach(id => { const el = _el(id); if (el) el.value = orderVal; });
    }

    ['table-product-topn', 'chart-product-topn'].forEach(id => {
      _el(id)?.addEventListener('change', e => {
        _productTopN = parseInt(e.target.value, 10);
        _syncProductControls();
        _renderRateSection();
      });
    });
    ['table-product-order', 'chart-product-order'].forEach(id => {
      _el(id)?.addEventListener('change', e => {
        _productOrder = e.target.value;
        _syncProductControls();
        _renderRateSection();
      });
    });

    // ── ECN dot click → popup ──────────────────────────────────────────────
    document.getElementById('saleout-table-container')?.addEventListener('click', e => {
      const dot = e.target.closest('.ecn-dot');
      if (!dot) return;
      const [modelCode, month] = dot.dataset.ecn.split('|');
      _showEcnPopup(modelCode, month);
    });

    // Đóng drilldown modal khi click backdrop hoặc nút close
    document.getElementById('drilldown-backdrop')?.addEventListener('click', () => {
      const modal = document.getElementById('drilldown-modal');
      if (modal) modal.style.display = 'none';
      const exportBtn = document.getElementById('drilldown-export');
      if (exportBtn) exportBtn.style.display = '';
    });
    document.getElementById('drilldown-close')?.addEventListener('click', () => {
      const modal = document.getElementById('drilldown-modal');
      if (modal) modal.style.display = 'none';
      const exportBtn = document.getElementById('drilldown-export');
      if (exportBtn) exportBtn.style.display = '';
    });

    // ── "+ Thêm bộ lọc" button ──────────────────────────────────────────────
    const addSoBtn  = _el('btn-add-so-filter');
    const addSoDd   = _el('add-so-filter-dropdown');
    if (addSoBtn && addSoDd) {
      addSoBtn.addEventListener('click', e => {
        e.stopPropagation();
        const isOpen = addSoDd.style.display !== 'none';
        addSoDd.style.display = isOpen ? 'none' : '';
        if (!isOpen) _renderAddSoFilterDropdown();
      });
      addSoDd.addEventListener('click', e => e.stopPropagation());
      document.addEventListener('click', () => { addSoDd.style.display = 'none'; });
    }
  }

  function getFilters()    { return _filters; }
  function getActiveSubTab() { return _activeSubTab; }

  // Direct filter API (dùng bởi ChatbotService — bypass DOM click để tránh stale reference)
  function setMonthFilter(months) {
    _filters.months = Array.isArray(months) ? months : [];
    renderSidebar();
    _onFilterApply();
  }
  function setProductFilter(shortNames) {
    _filters.shortNames = Array.isArray(shortNames) ? shortNames : [];
    renderSidebar();
    _onFilterApply();
  }

  function getCurrentData() {
    try {
      const efFiltered = _applyExtraFiltersOnly(_errorData);
      const byProduct  = ErrorRateService.calcByProduct(efFiltered, _saleoutData, _filters);
      const byMonth    = ErrorRateService.calcByMonth(efFiltered, _saleoutData, _filters);
      const sortedByRate = [...byProduct].sort((a, b) =>
        _productOrder === 'asc' ? (a.rate || 0) - (b.rate || 0) : (b.rate || 0) - (a.rate || 0)
      );
      const sortedByErrors = [...byProduct].sort((a, b) => (b.errors || 0) - (a.errors || 0));
      const sortedBySale   = [...byProduct].sort((a, b) => (b.sale   || 0) - (a.sale   || 0));
      // rawErrorCount = tổng lỗi sau filter (bao gồm cả SP không có saleout) — khớp "Tổng lỗi theo tháng" trên bảng
      const { fe: rawFe } = _applyFilters();
      // overallRate = TLL% lũy kế toàn giai đoạn = rate của tháng cuối cùng trong byMonth
      const lastMonth = byMonth[byMonth.length - 1];
      const overallRate = lastMonth?.rate ?? null;
      return {
        byProduct: (_productTopN > 0 ? sortedByRate.slice(0, _productTopN) : sortedByRate)
          .map(r => ({ name: r.short_name, errors: r.errors, sale: r.sale, rate: r.rate })),
        byProductByErrors: sortedByErrors.slice(0, 15)
          .map(r => ({ name: r.short_name, errors: r.errors, sale: r.sale, rate: r.rate })),
        byProductBySale: sortedBySale.slice(0, 20)
          .map(r => ({ name: r.short_name, errors: r.errors, sale: r.sale, rate: r.rate })),
        byMonth: byMonth.map(r => ({ month: r.month, errors: r.errors, sale: r.sale, rate: r.rate })),
        rawErrorCount: rawFe.length,
        overallRate,
        order: _productOrder,
        topN:  _productTopN,
      };
    } catch (_) { return { byProduct: [], byProductByErrors: [], byMonth: [], rawErrorCount: 0, overallRate: null, order: 'desc', topN: 20 }; }
  }

  function getUnfilteredByMonth() {
    try {
      const efFiltered = _applyExtraFiltersOnly(_errorData);
      // Giữ product filter (shortNames) nhưng bỏ month filter → trả về toàn bộ tháng của SP đang lọc
      const filtersNoMonth = { months: [], shortNames: _filters.shortNames || [] };
      const byMonth = ErrorRateService.calcByMonth(efFiltered, _saleoutData, filtersNoMonth);
      return byMonth.map(r => ({ month: r.month, errors: r.errors, sale: r.sale, rate: r.rate }));
    } catch (_) { return []; }
  }

  return { init, setData, render, renderSidebar, setLoading, getFilters, getExtraFilters, setExtraFilters, setNamespace, setEcnMap, getActiveSubTab, getCurrentData, getUnfilteredByMonth, setMonthFilter, setProductFilter };
})();
