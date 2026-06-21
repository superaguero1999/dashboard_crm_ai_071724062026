const ChatbotService = (() => {
  'use strict';

  let _history = [];
  let _lastProductFilterError = null; // flag cho read_dashboard_groups biết filter_product có thất bại không
  let _disambiguateCallback   = null; // callback để UI hiện disambiguation popup khi có nhiều match

  // ── Delay helper ──────────────────────────────────────────────────────────
  function _delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Visual simulation helpers ─────────────────────────────────────────────
  function _spawnRipple(el) {
    const rect = el.getBoundingClientRect();
    const ripple = document.createElement('div');
    ripple.className = 'ai-ripple';
    ripple.style.left = (rect.left + rect.width  / 2) + 'px';
    ripple.style.top  = (rect.top  + rect.height / 2) + 'px';
    document.body.appendChild(ripple);
    setTimeout(() => ripple.remove(), 650);
  }

  function _showActionLabel(el, text) {
    document.querySelectorAll('.ai-action-label').forEach(l => l.remove());
    const rect = el.getBoundingClientRect();
    const label = document.createElement('div');
    label.className = 'ai-action-label';
    label.textContent = text;
    // Hiển thị phía trên element, tránh tràn viewport
    const top = Math.max(4, rect.top - 30);
    label.style.left = rect.left + 'px';
    label.style.top  = top + 'px';
    document.body.appendChild(label);
    setTimeout(() => label.remove(), 1400);
  }

  async function _simulateClick(el, label) {
    if (!el) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await _delay(320);
    if (label) _showActionLabel(el, label);
    el.classList.add('ai-clicking');
    _spawnRipple(el);
    await _delay(680);
    el.click();
    el.classList.remove('ai-clicking');
    await _delay(380);
    return true;
  }

  // ── Month helpers ─────────────────────────────────────────────────────────
  function _prevMonth(code) {
    const y = parseInt(code.slice(1, 3), 10);
    const m = parseInt(code.slice(3, 5), 10);
    if (m === 1) return `Y${String(y - 1).padStart(2, '0')}12`;
    return `Y${String(y).padStart(2, '0')}${String(m - 1).padStart(2, '0')}`;
  }

  function _fmtMonth(code) {
    const y = parseInt(code.slice(1, 3), 10) + 2000;
    const m = parseInt(code.slice(3, 5), 10);
    return `${String(m).padStart(2, '0')}/${y}`;
  }

  // ── Tool executors ────────────────────────────────────────────────────────
  async function _execSwitchMainTab({ tab }) {
    const IDS    = { spm1: 'tab-saleout', spm2: 'tab-spm2', pivot: 'tab-pivot', dashboard: 'tab-dashboard' };
    const LABELS = { spm1: 'SPM1 – Thiết kế mới', spm2: 'SPM2 – Tất cả lỗi', pivot: 'Phân tích Pivot', dashboard: 'Biểu đồ chi tiết' };
    const el = document.getElementById(IDS[tab]);
    await _simulateClick(el, `AI: Chuyển sang ${LABELS[tab] || tab}`);
    return `Đã chuyển sang ${LABELS[tab] || tab}`;
  }

  async function _execSwitchSubTab({ tab }) {
    const IDS    = { rate: 'subtab-saleout-rate', data: 'subtab-saleout-data', pivot: 'subtab-pivot', dashboard: 'subtab-dashboard' };
    const LABELS = { rate: 'Tỷ lệ lỗi', data: 'Dữ liệu chi tiết', pivot: 'Phân tích', dashboard: 'Biểu đồ' };
    const el = document.getElementById(IDS[tab]);
    await _simulateClick(el, `AI: Chuyển sang tab ${LABELS[tab] || tab}`);
    return `Đã chuyển sang tab ${LABELS[tab] || tab}`;
  }

  function _isDashboard() {
    return (window.AppState?.getSummary?.()?.activeSection) === 'dashboard';
  }

  async function _execFilterProduct({ query }) {
    const q = (query || '').toLowerCase().trim();

    if (_isDashboard()) {
      // Dashboard tab: dùng SlicerService cho field product_shortname
      const dash = window.AppState?.getDashboardSummary?.() || {};
      const matches = (dash.uniqueProducts || []).filter(p => p.toLowerCase().includes(q));
      if (!matches.length) {
        _lastProductFilterError = query;
        return `Không tìm thấy sản phẩm khớp với "${query}" trong dataset hiện tại`;
      }
      let chosen = matches[0];
      if (matches.length > 1 && typeof _disambiguateCallback === 'function') {
        chosen = await new Promise(resolve => _disambiguateCallback({ candidates: matches, resolve }));
        if (!chosen) {
          _lastProductFilterError = query;
          return `Đã huỷ — không chọn sản phẩm`;
        }
      }
      _lastProductFilterError = null;
      SlicerService.setFieldFilter('product_shortname', [chosen]);
      DashboardRenderer?.render?.();
      await _delay(200);
      return `Đã lọc dashboard theo sản phẩm: ${chosen}`;
    }

    // SaleOut tab: dùng pill DOM, cũng hỗ trợ disambiguation
    const pills = [...document.querySelectorAll('.so-pill[data-type="product"]')]
      .filter(p => (p.dataset.value || '').toLowerCase().includes(q));
    if (!pills.length) return `Không tìm thấy sản phẩm khớp với "${query}" trong dữ liệu hiện tại`;
    let pill = pills[0];
    if (pills.length > 1 && typeof _disambiguateCallback === 'function') {
      const chosenName = await new Promise(resolve =>
        _disambiguateCallback({ candidates: pills.map(p => p.dataset.value), resolve })
      );
      if (!chosenName) return `Đã huỷ — không chọn sản phẩm`;
      pill = pills.find(p => p.dataset.value === chosenName) || pill;
    }
    const productName = pill.dataset.value;
    const current = SaleOutRenderer.getFilters?.()?.shortNames || [];
    let next;
    if (current.length === 0) next = [productName];
    else if (current.includes(productName)) next = current.filter(v => v !== productName);
    else next = [...current, productName];
    SaleOutRenderer.setProductFilter(next);
    _spawnRipple(pill);
    _showActionLabel(pill, `AI: Chọn sản phẩm "${productName}"`);
    await _delay(200);
    return `Đã lọc sản phẩm: ${productName}`;
  }

  async function _execFilterMonth({ month }) {
    // AI có thể trả về 1 tháng ("Y2507") hoặc nhiều tháng cách dấu phẩy ("Y2507,Y2508,Y2509")
    const incoming = (month || '').split(',').map(m => m.trim()).filter(Boolean);
    if (!incoming.length) return 'Không xác định được tháng';

    // Validate: kiểm tra mã tháng có tồn tại trong dữ liệu không (phát hiện AI nhầm năm)
    const availableMonths = (window.AppState?.getDashboardSummary?.()?.uniqueMonths)
      || (window.AppState?.getSummary?.()?.tableByMonth || []).map(r => r.month);
    if (availableMonths.length) {
      const missing = incoming.filter(m => !availableMonths.includes(m));
      if (missing.length === incoming.length) {
        const hint = availableMonths.slice(0, 8).join(', ');
        return `Không tìm thấy tháng ${missing.join(', ')} trong dữ liệu (có thể AI nhầm năm). Tháng có dữ liệu: ${hint}...`;
      }
    }

    if (_isDashboard()) {
      // Dashboard tab: dùng SlicerService cho field month
      SlicerService.setFieldFilter('month', incoming);
      DashboardRenderer?.render?.();
      await _delay(150);
      return `Đã lọc dashboard theo tháng: ${incoming.join(', ')}`;
    }

    // SaleOut tab: dùng SaleOutRenderer trực tiếp
    let next;
    if (incoming.length > 1) {
      next = incoming;
    } else {
      const m = incoming[0];
      const current = SaleOutRenderer.getFilters?.()?.months || [];
      if (current.length === 0) next = [m];
      else if (current.includes(m)) next = current.filter(v => v !== m);
      else next = [...current, m];
    }

    SaleOutRenderer.setMonthFilter(next);

    // Visual feedback trên từng pill
    for (const m of incoming) {
      const pill = [...document.querySelectorAll('.so-pill[data-type="month"]')]
        .find(p => (p.dataset.value || '').trim() === m);
      if (pill) { _spawnRipple(pill); _showActionLabel(pill, `AI: Chọn tháng ${m}`); }
    }
    await _delay(150);
    return `Đã lọc tháng: ${next.join(', ')}`;
  }

  async function _execClearFilters() {
    _lastProductFilterError = null;
    if (_isDashboard()) {
      SlicerService.clearAllValues?.();
      DashboardRenderer?.render?.();
    } else {
      SaleOutRenderer.setMonthFilter([]);
      SaleOutRenderer.setProductFilter([]);
    }
    await _delay(150);
    return 'Đã xoá tất cả filter';
  }

  async function _execSetTopN({ n }) {
    const sel = document.getElementById('table-product-topn');
    if (!sel) return 'Không tìm thấy control Top N';
    await _simulateClick(sel, `AI: Đặt hiển thị Top ${n || 'tất cả'}`);
    sel.value = String(n);
    sel.dispatchEvent(new Event('change'));
    return `Đã đặt hiển thị Top ${n || 'tất cả'} sản phẩm`;
  }

  async function _execSetSortOrder({ order }) {
    const sel = document.getElementById('table-product-order');
    if (!sel) return 'Không tìm thấy control sắp xếp';
    await _simulateClick(sel, `AI: Sắp xếp ${order === 'desc' ? 'giảm dần' : 'tăng dần'}`);
    sel.value = order;
    sel.dispatchEvent(new Event('change'));
    return `Đã sắp xếp ${order === 'desc' ? 'giảm dần (cao nhất trước)' : 'tăng dần (thấp nhất trước)'}`;
  }

  async function _execSetChartType({ type }) {
    const LABELS = { bar: 'Cột', line: 'Đường', area: 'Diện tích', pie: 'Tròn', doughnut: 'Donut' };
    const btn = document.querySelector(`[data-chart-type="${type}"]`);
    await _simulateClick(btn, `AI: Biểu đồ ${LABELS[type] || type}`);
    return `Đã đổi sang biểu đồ ${LABELS[type] || type}`;
  }

  async function _execReadCurrentState() {
    try {
      const s = window.AppState?.getSummary?.() || {};
      const filterParts = [];
      if (s.selectedMonths?.length)   filterParts.push(`tháng đang lọc: ${s.selectedMonths.join(', ')}`);
      if (s.selectedProducts?.length) filterParts.push(`SP đang lọc: ${s.selectedProducts.join(', ')}`);
      return [
        `Dataset: ${s.activeDataset === 'spm2' ? 'SPM2 (tất cả lỗi)' : 'SPM1 (thiết kế mới)'}`,
        `Tab: ${s.activeSubTab || 'rate'}`,
        `Records hiện tại: ${s.recordCount || 0}`,
        filterParts.length ? filterParts.join('; ') : 'Chưa có filter nào',
        `Tháng có dữ liệu: ${(s.saleoutMonths || []).join(', ')}`,
        `Danh sách SP: ${(s.saleoutProducts || []).join(', ')}`,
      ].join('\n');
    } catch (_) { return 'Không đọc được trạng thái'; }
  }

  // Đọc tổng lỗi từ dữ liệu SAU KHI filter đã được áp dụng
  async function _execSumErrors() {
    try {
      if (_isDashboard()) {
        const dash = window.AppState?.getDashboardSummary?.() || {};
        const filterParts = (dash.activeSlicers || []).map(sl => `${sl.field}: ${sl.values.join(', ')}`);
        const filterStr = filterParts.length ? `(${filterParts.join('; ')})` : '(toàn bộ)';
        return `Tổng số lỗi dashboard ${filterStr}: ${dash.filteredCount}`;
      }
      const s = window.AppState?.getSummary?.() || {};
      const total = s.rawErrorCount !== null && s.rawErrorCount !== undefined
        ? s.rawErrorCount
        : (s.tableByMonth || []).reduce((acc, r) => acc + (r.errors || 0), 0);
      const filterParts = [];
      if (s.selectedMonths?.length)   filterParts.push(`tháng ${s.selectedMonths.join(', ')}`);
      if (s.selectedProducts?.length) filterParts.push(`SP ${s.selectedProducts.join(', ')}`);
      const filterStr = filterParts.length ? `(${filterParts.join('; ')})` : '(toàn bộ)';
      return `Tổng số lỗi ${filterStr}: ${total}`;
    } catch (_) { return 'Không tính được tổng lỗi'; }
  }

  async function _execSumRate() {
    try {
      if (_isDashboard()) {
        return 'TLL% không tính được trên tab Biểu đồ (cần dữ liệu Sale Out từ tab Tỷ lệ lỗi)';
      }
      const s = window.AppState?.getSummary?.() || {};
      const rate = s.overallRate;
      const filterParts = [];
      if (s.selectedMonths?.length)   filterParts.push(`tháng ${s.selectedMonths.join(', ')}`);
      if (s.selectedProducts?.length) filterParts.push(`SP ${s.selectedProducts.join(', ')}`);
      const filterStr = filterParts.length ? `(${filterParts.join('; ')})` : '(toàn bộ)';
      return rate !== null && rate !== undefined
        ? `TLL% ${filterStr}: ${rate.toFixed(2)}%`
        : 'Không tính được TLL% (thiếu dữ liệu sale out)';
    } catch (_) { return 'Không tính được TLL%'; }
  }

  // Phân tích xu hướng nhiều tháng: so sánh, delta MoM, phát hiện bất thường
  async function _execAnalyzeTrend({ months }) {
    try {
      // Tạm thời bỏ month filter để lấy đủ data tất cả tháng (giữ product filter)
      const savedMonths = SaleOutRenderer.getFilters?.()?.months || [];
      if (savedMonths.length) SaleOutRenderer.setMonthFilter([]);
      await _delay(80);

      const s = window.AppState?.getSummary?.() || {};
      const allByMonth = s.tableByMonth || [];

      if (savedMonths.length) SaleOutRenderer.setMonthFilter(savedMonths);

      if (!allByMonth.length) return 'Không có dữ liệu tháng để phân tích';

      const targets = Array.isArray(months) && months.length
        ? months.filter(m => allByMonth.some(r => r.month === m))
        : allByMonth.map(r => r.month);

      if (!targets.length) return `Không tìm thấy dữ liệu cho tháng: ${(months || []).join(', ')}`;

      // Tỷ lệ riêng từng tháng = errors/sale*100 (không dùng r.rate vì r.rate là lũy kế toàn kỳ)
      const monthRate = r => (r && r.errors != null && r.sale > 0) ? (r.errors / r.sale) * 100 : null;

      // Trung bình toàn kỳ — chỉ tính trên tháng có dữ liệu thực (sale > 0), tránh pha loãng bằng tháng trống
      const activeMonths = allByMonth.filter(r => (r.sale || 0) > 0 || (r.errors || 0) > 0);
      const totalAllErr  = activeMonths.reduce((a, r) => a + (r.errors || 0), 0);
      const totalAllSale = activeMonths.reduce((a, r) => a + (r.sale   || 0), 0);
      const avgRate   = totalAllSale > 0 ? (totalAllErr / totalAllSale) * 100 : 0;
      const avgErrors = activeMonths.length ? totalAllErr / activeMonths.length : 0;

      const filterCtx = (s.selectedProducts?.length)
        ? ` (SP: ${s.selectedProducts.join(', ')})` : '';
      const lines = [`📊 Phân tích xu hướng lỗi${filterCtx}:`];

      for (const mCode of targets) {
        const r = allByMonth.find(x => x.month === mCode);
        if (!r) continue;
        const rate = monthRate(r);
        const prev = allByMonth.find(x => x.month === _prevMonth(mCode));
        const prevRate = monthRate(prev);
        const delta = (rate != null && prevRate != null) ? rate - prevRate : null;
        const ratio = (rate != null && avgRate > 0) ? rate / avgRate : null;

        let line = `• ${_fmtMonth(mCode)}: ${r.errors} lỗi / ${r.sale} sale → TLL% ${rate != null ? rate.toFixed(2) + '%' : 'N/A'}`;
        if (delta != null) line += ` | MoM: ${delta > 0 ? '+' : ''}${delta.toFixed(2)}%`;
        if (ratio != null) {
          if (ratio > 1.5) line += ` ⚠️ cao hơn TB ${ratio.toFixed(1)}x`;
          else if (ratio < 0.5) line += ` ✅ thấp hơn TB ${ratio.toFixed(1)}x`;
        }
        lines.push(line);
      }

      if (activeMonths.length) {
        lines.push(`\nTrung bình (${activeMonths.length} tháng có dữ liệu): TLL% TB = ${avgRate.toFixed(2)}% | lỗi TB = ${avgErrors.toFixed(1)}/tháng`);
      }

      if (targets.length >= 2) {
        const firstR = allByMonth.find(x => x.month === targets[0]);
        const lastR  = allByMonth.find(x => x.month === targets[targets.length - 1]);
        const first  = monthRate(firstR);
        const last   = monthRate(lastR);
        if (first != null && last != null) {
          const diff = last - first;
          if      (diff >  0.2) lines.push(`📈 Xu hướng: TĂNG (${first.toFixed(2)}% → ${last.toFixed(2)}%)`);
          else if (diff < -0.2) lines.push(`📉 Xu hướng: GIẢM (${first.toFixed(2)}% → ${last.toFixed(2)}%)`);
          else                  lines.push(`➡️ Xu hướng: ỔN ĐỊNH quanh ${((first + last) / 2).toFixed(2)}%`);
        }
      }

      const anomalies = targets.filter(m => {
        const r = allByMonth.find(x => x.month === m);
        const rt = monthRate(r);
        return rt != null && avgRate > 0 && rt > avgRate * 1.5;
      });
      if (anomalies.length) {
        lines.push(`⚠️ Tháng bất thường (TLL% > 1.5x TB): ${anomalies.map(m => _fmtMonth(m)).join(', ')}`);
      } else {
        lines.push(`✅ Không phát hiện bất thường trong kỳ phân tích`);
      }

      return lines.join('\n');
    } catch (err) { return `Không phân tích được xu hướng: ${err.message}`; }
  }

  // Đọc bảng nhóm lỗi / linh kiện lỗi / nguyên nhân từ dashboard SAU KHI filter đã áp dụng
  async function _execReadDashboardGroups({ by, limit }) {
    try {
      if (_lastProductFilterError) {
        const q = _lastProductFilterError;
        _lastProductFilterError = null;
        return `Không tìm thấy sản phẩm "${q}" trong dataset hiện tại. Kiểm tra lại tên sản phẩm hoặc chuyển sang dataset khác (SPM1/SPM2).`;
      }
      const dash = window.AppState?.getDashboardSummary?.() || {};
      const n = Math.min(Math.max(parseInt(limit) || 10, 1), 50);
      const filterParts = (dash.activeSlicers || []).map(sl => `${sl.field}: ${sl.values.join(', ')}`);
      const filterStr = filterParts.length ? `(${filterParts.join('; ')})` : '(toàn bộ)';

      let rows, label;
      if (by === 'accessory' || by === 'linh_kien') {
        rows  = (dash.topByAccessory || []).slice(0, n);
        label = 'Linh kiện lỗi';
      } else if (by === 'cause' || by === 'nguyen_nhan') {
        rows  = (dash.topByCause || []).slice(0, n);
        label = 'Nguyên nhân lỗi';
      } else {
        rows  = (dash.topByCategory || []).slice(0, n);
        label = 'Nhóm lỗi';
      }

      if (!rows.length) return `Không có dữ liệu ${label} ${filterStr}`;
      const lines = [`Top ${n} ${label} ${filterStr} (tổng: ${dash.filteredCount} bản ghi):`];
      rows.forEach((r, i) => lines.push(`${i + 1}. ${r.name}: ${r.count} lỗi`));
      return lines.join('\n');
    } catch (err) { return `Không đọc được nhóm lỗi: ${err.message}`; }
  }

  // Đọc bảng xếp hạng sản phẩm SAU KHI filter đã áp dụng
  async function _execReadTopProducts({ limit, by }) {
    try {
      const n = parseInt(limit) || 10;
      const s = window.AppState?.getSummary?.() || {};
      const filterParts = [];
      if (s.selectedMonths?.length)   filterParts.push(`tháng ${s.selectedMonths.join(', ')}`);
      if (s.selectedProducts?.length) filterParts.push(`SP ${s.selectedProducts.join(', ')}`);
      const filterStr = filterParts.length ? `(${filterParts.join('; ')})` : '(toàn bộ)';
      const fmt = r => (r.rate !== null && r.rate !== undefined) ? r.rate.toFixed(2) + '%' : 'N/A';

      if (by === 'rate') {
        const rows = (s.tableByProduct || []).slice(0, n);
        if (!rows.length) return 'Không có dữ liệu sản phẩm';
        const lines = [`Top ${n} sản phẩm TLL% cao nhất ${filterStr}:`];
        rows.forEach((r, i) => lines.push(`${i + 1}. ${r.name}: TLL%=${fmt(r)} (lỗi=${r.errors}, sale=${r.sale})`));
        return lines.join('\n');
      } else if (by === 'sale') {
        // Xếp hạng theo saleout — dùng tableByProductSale (đã sort theo sale, top 20 toàn bộ SP kể cả SP ít lỗi)
        const rows = (s.tableByProductSale || []).slice(0, n);
        if (!rows.length) return 'Không có dữ liệu sản phẩm';
        const lines = [`Top ${n} sản phẩm saleout nhiều nhất ${filterStr}:`];
        rows.forEach((r, i) => lines.push(`${i + 1}. ${r.name}: Sale=${r.sale} (lỗi=${r.errors}, TLL%=${fmt(r)})`));
        return lines.join('\n');
      } else {
        const rows = (s.tableByProductErrors || []).slice(0, n);
        if (!rows.length) return 'Không có dữ liệu sản phẩm';
        const lines = [`Top ${n} sản phẩm lỗi nhiều nhất ${filterStr}:`];
        rows.forEach((r, i) => lines.push(`${i + 1}. ${r.name}: ${r.errors} lỗi (sale=${r.sale}, TLL%=${fmt(r)})`));
        return lines.join('\n');
      }
    } catch (err) { return `Không đọc được dữ liệu: ${err.message}`; }
  }

  // Đọc dữ liệu sale out thực từ hệ thống theo năm hoặc dải tháng (KHÔNG hallucinate)
  // year/months: lọc nội bộ trên dữ liệu không filter → dùng cho "dữ liệu saleout năm 2025"
  // Không có year/months: dùng tableByMonth đã filtered → dùng sau khi filter_month đã set
  async function _execReadSaleoutTable({ year, months }) {
    try {
      let targets;

      if (year || (months && months.length)) {
        // Có tham số năm/tháng cụ thể → lấy từ nguồn unfiltered, lọc nội bộ
        const allUnfiltered = window.AppState?.getAllMonthsData?.() || [];
        if (!allUnfiltered.length) return 'Không có dữ liệu saleout trong hệ thống (chưa import dữ liệu)';
        if (year) {
          const y2 = String(year).length === 4 ? String(year).slice(-2) : String(year);
          targets = allUnfiltered.filter(r => r.month && r.month.startsWith('Y' + y2));
        } else {
          const mSet = new Set(Array.isArray(months) ? months : [months]);
          targets = allUnfiltered.filter(r => mSet.has(r.month));
        }
      } else {
        // Không có tham số → dùng tableByMonth đã filtered theo UI (tháng + sản phẩm hiện tại)
        targets = window.AppState?.getSummary?.()?.tableByMonth || [];
        // Lọc bỏ tháng có sale=0 và lỗi=0 (tháng tương lai chưa có dữ liệu)
        targets = targets.filter(r => (r.sale || 0) > 0 || (r.errors || 0) > 0);
      }

      if (!targets.length) {
        const hint = (window.AppState?.getAllMonthsData?.() || []).map(r => r.month).join(', ');
        return `Không có dữ liệu saleout${year ? ' năm ' + year : ''}. Tháng có dữ liệu: ${hint}`;
      }

      const label = year ? ` năm ${year}` : '';
      const lines = [`📦 Dữ liệu Sale Out${label}:`];
      let tSale = 0, tErr = 0;
      for (const r of targets) {
        const rate = (r.sale > 0) ? (r.errors / r.sale * 100).toFixed(2) + '%' : 'N/A';
        lines.push(`• ${_fmtMonth(r.month)}: Sale=${r.sale} | Lỗi=${r.errors} | TLL%=${rate}`);
        tSale += (r.sale  || 0);
        tErr  += (r.errors || 0);
      }
      if (targets.length > 1) {
        const rate = tSale > 0 ? (tErr / tSale * 100).toFixed(2) + '%' : 'N/A';
        lines.push(`\n📊 Tổng cộng${label}: Sale=${tSale} | Lỗi=${tErr} | TLL%=${rate}`);
      }
      return lines.join('\n');
    } catch (err) { return `Không đọc được dữ liệu saleout: ${err.message}`; }
  }

  const EXECUTORS = {
    switch_main_tab:   _execSwitchMainTab,
    switch_sub_tab:    _execSwitchSubTab,
    filter_product:    _execFilterProduct,
    filter_month:      _execFilterMonth,
    clear_filters:     _execClearFilters,
    set_top_n:         _execSetTopN,
    set_sort_order:    _execSetSortOrder,
    set_chart_type:    _execSetChartType,
    read_state:           _execReadCurrentState,
    sum_errors:           _execSumErrors,
    sum_rate:             _execSumRate,
    analyze_trend:        _execAnalyzeTrend,
    read_top_products:    _execReadTopProducts,
    read_dashboard_groups: _execReadDashboardGroups,
    read_saleout_table:    _execReadSaleoutTable,
  };

  // Tạo system message kèm dữ liệu thực từ dashboard
  function _buildSystemMessage() {
    const s = window.AppState?.getSummary?.() || {};
    const filterParts = [];
    if (s.selectedMonths?.length)   filterParts.push(`tháng: ${s.selectedMonths.join(', ')}`);
    if (s.selectedProducts?.length) filterParts.push(`SP: ${s.selectedProducts.join(', ')}`);

    const fmt = r => r.rate !== null && r.rate !== undefined ? r.rate.toFixed(2) + '%' : 'N/A';

    // Giới hạn 5 SP để giảm token (đủ cho câu hỏi tổng quan; chi tiết hơn dùng tools)
    const productLines = (s.tableByProduct || []).slice(0, 5).map((r, i) =>
      `${i + 1}. ${r.name}: lỗi=${r.errors} sale=${r.sale} TLL%=${fmt(r)}`
    ).join('\n');

    const errorRankLines = (s.tableByProductErrors || []).slice(0, 5).map((r, i) =>
      `${i + 1}. ${r.name}: lỗi=${r.errors} sale=${r.sale} TLL%=${fmt(r)}`
    ).join('\n');

    // Giới hạn 18 tháng gần nhất (tools đọc đầy đủ khi cần); unfiltered để AI thấy đúng bức tranh toàn cảnh
    const allUnfilteredMonths = window.AppState?.getAllMonthsData?.() || [];
    const allMonths = (allUnfilteredMonths.length ? allUnfilteredMonths : (s.tableByMonth || []));
    const monthLines = allMonths.slice(-18).map(r =>
      `${r.month}: lỗi=${r.errors} sale=${r.sale} TLL%=${fmt(r)}`
    ).join('\n');

    // Nếu đang ở Dashboard tab — expose dữ liệu dashboard riêng
    if (s.activeSection === 'dashboard') {
      const dash = window.AppState?.getDashboardSummary?.() || {};
      const slicerInfo = (dash.activeSlicers || []).length
        ? (dash.activeSlicers || []).map(sl => `${sl.field}: ${sl.values.join(', ')}`).join('; ')
        : 'không có';
      const fmtGroup = (arr) => (arr || []).slice(0, 8).map((r, i) => `${i+1}. ${r.name}: ${r.count} lỗi`).join(', ');
      const dashLines = [
        `Tab hiện tại: Biểu đồ chi tiết lỗi (Dashboard) — Dataset:${s.activeDataset || 'spm1'}`,
        `Tổng bản ghi: ${dash.totalCount} | Sau slicer filter: ${dash.filteredCount}`,
        `Slicer đang bật: ${slicerInfo}`,
        `Tháng có dữ liệu: ${(dash.uniqueMonths || []).join(', ')}`,
        `Sản phẩm: ${(dash.uniqueProducts || []).slice(0, 12).join(', ')}`,
        dash.topByCategory?.length  ? `\nNHÓM LỖI (category): ${fmtGroup(dash.topByCategory)}`  : '',
        dash.topByAccessory?.length ? `LINH KIỆN LỖI (err_accessory): ${fmtGroup(dash.topByAccessory)}` : '',
        dash.topByCause?.length     ? `NGUYÊN NHÂN (cause): ${fmtGroup(dash.topByCause)}`       : '',
        '\nLưu ý: Dữ liệu trên là snapshot KHI BUILD system message. Gọi read_dashboard_groups để lấy số liệu MỚI NHẤT sau filter.',
        'filter_month/filter_product sẽ cập nhật slicer dashboard. sum_rate không dùng được ở đây.',
      ].filter(Boolean).join('\n');
      return SYSTEM_INSTRUCTION + '\n\n=== DỮ LIỆU DASHBOARD ===\n' + dashLines
        + '\n\n⚠️ OUTPUT: Chỉ trả về 1 JSON object thuần túy. Không markdown, không code block, không text nào khác.';
    }

    const tabLabel = { rate: 'Tỷ lệ lỗi (TLL)', data: 'Dữ liệu chi tiết', pivot: 'Phân tích Pivot' };
    const stateLines = [
      `Dataset:${s.activeDataset || 'spm1'} Tab hiện tại:${tabLabel[s.activeSubTab] || s.activeSubTab || 'rate'} Records:${s.recordCount || 0}`,
      filterParts.length ? `Filter:${filterParts.join('; ')}` : 'Filter: không có',
      errorRankLines ? `\nTOP SẢN PHẨM LỖI NHIỀU NHẤT (xếp theo số lỗi):\n${errorRankLines}` : '',
      productLines ? `\nBẢNG SẢN PHẨM THEO TLL% (xếp theo ${s.tableOrder === 'asc' ? 'TLL% thấp nhất' : 'TLL% cao nhất'}):\n${productLines}` : '',
      monthLines   ? `\nBẢNG THÁNG:\n${monthLines}` : '',
    ].filter(Boolean).join('\n');

    return SYSTEM_INSTRUCTION + '\n\n=== DỮ LIỆU DASHBOARD ===\n' + stateLines
      + '\n\n⚠️ OUTPUT: Chỉ trả về 1 JSON object thuần túy. Không markdown, không code block, không text nào khác.';
  }

  // ── Tool definitions (dùng cho cả Gemini và Groq) ────────────────────────
  const TOOL_DEFS = [
    { name: 'switch_main_tab',
      description: 'Switch dataset: spm1=SPM1 (thiết kế mới), spm2=SPM2 (tất cả lỗi)',
      parameters: { type: 'object', properties: { tab: { type: 'string', enum: ['spm1','spm2'] } }, required: ['tab'] } },
    { name: 'switch_sub_tab',
      description: 'Switch tab con: rate=Tỷ lệ lỗi, data=Dữ liệu chi tiết, pivot=Phân tích, dashboard=Biểu đồ',
      parameters: { type: 'object', properties: { tab: { type: 'string', enum: ['rate','data','pivot','dashboard'] } }, required: ['tab'] } },
    { name: 'filter_product',
      description: 'Lọc theo tên/mã SP. Dùng tên ngắn: S66, S88, KAE-S68, PLATINUM S22, v.v.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'filter_month',
      description: 'Lọc 1 tháng (gọi nhiều lần cho dải). Format: Y2601=1/2026, Y2501=1/2025.',
      parameters: { type: 'object', properties: { month: { type: 'string', description: 'Ví dụ: Y2501, Y2502' } }, required: ['month'] } },
    { name: 'clear_filters',
      description: 'Xoá tất cả filter SP và tháng đang bật',
      parameters: { type: 'object', properties: {} } },
    { name: 'set_top_n',
      description: 'Hiển thị Top N sản phẩm (0=tất cả)',
      parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } },
    { name: 'set_sort_order',
      description: 'Sắp xếp: desc=giảm dần (SP lỗi nhiều nhất lên đầu), asc=tăng dần',
      parameters: { type: 'object', properties: { order: { type: 'string', enum: ['asc','desc'] } }, required: ['order'] } },
    { name: 'set_chart_type',
      description: 'Đổi loại biểu đồ',
      parameters: { type: 'object', properties: { type: { type: 'string', enum: ['bar','line','area','pie','doughnut'] } }, required: ['type'] } },
    { name: 'read_state',
      description: 'Đọc trạng thái chi tiết dashboard để trả lời câu hỏi số liệu',
      parameters: { type: 'object', properties: {} } },
    { name: 'read_top_products',
      description: 'Đọc bảng xếp hạng sản phẩm SAU KHI filter đã áp dụng. by=errors: xếp theo số lỗi; by=rate: xếp theo TLL%; by=sale: xếp theo saleout (số bán ra nhiều nhất).',
      parameters: { type: 'object', properties: {
        limit: { type: 'number', description: 'Số sản phẩm hiển thị (mặc định 10)' },
        by:    { type: 'string', enum: ['errors', 'rate', 'sale'], description: 'Xếp theo: errors=lỗi nhiều nhất, rate=TLL% cao nhất, sale=saleout nhiều nhất' },
      }, required: ['by'] } },
    { name: 'read_dashboard_groups',
      description: 'Đọc xếp hạng nhóm lỗi/linh kiện/nguyên nhân từ Dashboard tab SAU KHI filter. by=category: nhóm lỗi; by=accessory: linh kiện lỗi; by=cause: nguyên nhân lỗi.',
      parameters: { type: 'object', properties: {
        by:    { type: 'string', enum: ['category', 'accessory', 'cause'], description: 'Loại nhóm cần đọc' },
        limit: { type: 'number', description: 'Số nhóm hiển thị (mặc định 10)' },
      }, required: ['by'] } },
    { name: 'read_saleout_table',
      description: 'Đọc dữ liệu Sale Out thực (sale + lỗi + TLL%) theo năm hoặc dải tháng. LUÔN dùng tool này khi hỏi về dữ liệu saleout, tổng bán ra. KHÔNG tự tính.',
      parameters: { type: 'object', properties: {
        year:   { type: 'number', description: 'Năm cần đọc, VD: 2025, 2026. Để trống nếu dùng months.' },
        months: { type: 'array', items: { type: 'string' }, description: 'Dải tháng cụ thể, VD: ["Y2501","Y2502"]. Dùng thay year nếu cần tháng cụ thể.' },
      } } },
  ];

  const SYSTEM_INSTRUCTION = `Bạn là trợ lý AI điều khiển dashboard CRM phân tích lỗi sản phẩm Karofi. Luôn trả lời bằng JSON hợp lệ:
{"actions":[...],"reply":"..."}

══ 3 TAB CHÍNH — AI TỰ ĐỘNG CHUYỂN TAB TRƯỚC KHI TRẢ LỜI ══

Tab 1: "Tỷ lệ lỗi (TLL)" → switch_sub_tab(rate)
  Nội dung: TLL% từng tháng, TLL% từng sản phẩm, xu hướng tăng giảm, so sánh tháng
  Chuyển sang tab này khi user hỏi: tỷ lệ lỗi, TLL%, xu hướng, tăng giảm, sale out, tháng nào cao/thấp, so sánh tháng

Tab 2: "Dữ liệu chi tiết" → switch_sub_tab(data)
  Nội dung: Bảng dữ liệu đầy đủ các bản ghi lỗi, cột Tổng lỗi + Sale Out + TLL%
  Chuyển sang tab này khi user hỏi: dữ liệu chi tiết, bảng đầy đủ, tổng lỗi là bao nhiêu, xem tất cả dữ liệu, bao nhiêu bản ghi

Tab 3: "Biểu đồ chi tiết lỗi" → switch_sub_tab(dashboard)
  Nội dung: Phân nhóm lỗi (nguyên nhân, loại lỗi, phân loại), số lượng lỗi theo model/tháng, bộ lọc slicer
  Chuyển sang tab này khi user hỏi: loại lỗi gì, nhóm lỗi, nguyên nhân lỗi, lỗi linh kiện, lỗi ngoại quan, lỗi theo model, chi tiết từng loại lỗi, biểu đồ phân tích

QUY TẮC CHUYỂN TAB TỰ ĐỘNG:
- LUÔN thêm switch_sub_tab là ACTION ĐẦU TIÊN, trước mọi action khác, khi câu hỏi khớp với tab tương ứng
- Sau khi chuyển tab, tiếp tục thực hiện các action khác (filter, sum, analyze) như bình thường
- Nếu user đang ở đúng tab rồi (xem "Tab hiện tại" trong DỮ LIỆU), KHÔNG cần chuyển lại
- Ví dụ: "tỷ lệ lỗi tháng 6/2025" → switch_sub_tab(rate) + clear_filters + filter_month(Y2506) + sum_rate
- Ví dụ: "tổng lỗi tháng 6/2026" → switch_sub_tab(data) + clear_filters + filter_month(Y2606) + sum_errors
- Ví dụ: "loại lỗi nào nhiều nhất" → switch_sub_tab(dashboard) + read_dashboard_groups(by=category)
- Ví dụ: "chi tiết lỗi model S88" / "S88 lỗi gì" → switch_sub_tab(dashboard) + filter_product("S88") + read_dashboard_groups(by=category) → reply trực tiếp từ kết quả tool
- QUY TẮC: Khi user hỏi về CHI TIẾT LỖI / DANH SÁCH LỖI / NHÓM LỖI của 1 model/SP → LUÔN dùng dashboard + filter_product + read_dashboard_groups, KHÔNG chỉ sum_errors

ACTIONS có sẵn:
- {"name":"switch_main_tab","args":{"tab":"spm1|spm2"}}   -- CHỈ khi user nói rõ "SPM1","SPM2","chuyển dataset"
- {"name":"switch_sub_tab","args":{"tab":"rate|data|pivot|dashboard"}}  -- TỰ ĐỘNG theo nội dung hỏi
- {"name":"filter_product","args":{"query":"tên SP hoặc mã model"}}  -- "model S22"/"sản phẩm S22"/"SP S66" đều dùng action này
- {"name":"filter_month","args":{"month":"Y2507"}}              -- 1 tháng
- {"name":"filter_month","args":{"month":"Y2507,Y2508,Y2509"}}  -- nhiều tháng, cách nhau dấu phẩy
- {"name":"clear_filters","args":{}}
- {"name":"set_top_n","args":{"n":10}}
- {"name":"set_sort_order","args":{"order":"desc|asc"}}
- {"name":"set_chart_type","args":{"type":"bar|line|area|pie|doughnut"}}
- {"name":"sum_errors","args":{}}  -- đọc TỔNG số lỗi SAU khi filter xong. Chỉ trả về con số tổng.
- {"name":"sum_rate","args":{}}    -- đọc TLL% (lỗi/sale lũy kế) SAU khi filter xong (gọi cuối cùng)
- {"name":"read_top_products","args":{"by":"errors","limit":10}}  -- đọc bảng xếp hạng sản phẩm/model SAU khi filter. by=errors: theo số lỗi, by=rate: theo TLL%, by=sale: theo saleout (số bán ra)
- {"name":"read_dashboard_groups","args":{"by":"category","limit":10}}  -- ĐỌC NHÓM LỖI từ Dashboard SAU khi filter. by=category: nhóm lỗi, by=accessory: linh kiện lỗi, by=cause: nguyên nhân lỗi. CHỈ dùng khi đang ở Dashboard tab.
- {"name":"read_saleout_table","args":{"year":2025}}  -- ĐỌC DỮ LIỆU SALE OUT THEO THÁNG. Dùng khi hỏi: "dữ liệu saleout năm X", "sale theo từng tháng", "tổng bán ra năm X". KHÔNG TỰ TẠO SỐ.
- {"name":"read_saleout_table","args":{"months":["Y2501","Y2502"]}}  -- đọc saleout từng tháng theo dải tháng cụ thể
- {"name":"read_saleout_table","args":{}}  -- đọc saleout theo filter hiện tại (dùng sau khi filter_month đã set)
- {"name":"analyze_trend","args":{"months":["Y2603","Y2604"]}}  -- so sánh xu hướng nhiều tháng, phát hiện bất thường, tính delta MoM. KHÔNG cần clear_filters trước.

MONTH FORMAT: Y + 2 chữ số NĂM + 2 chữ số THÁNG
- NĂM 2025 → 25 | NĂM 2026 → 26  (KHÔNG nhầm: 2025 ≠ 26)
- 01/2025=Y2501  02/2025=Y2502  03/2025=Y2503  04/2025=Y2504  05/2025=Y2505  06/2025=Y2506
- 07/2025=Y2507  08/2025=Y2508  09/2025=Y2509  10/2025=Y2510  11/2025=Y2511  12/2025=Y2512
- 01/2026=Y2601  02/2026=Y2602  03/2026=Y2603  04/2026=Y2604  05/2026=Y2605  06/2026=Y2606
- 07/2026=Y2607  08/2026=Y2608  09/2026=Y2609  10/2026=Y2610  11/2026=Y2611  12/2026=Y2612
⚠️ VÍ DỤ PHÂN BIỆT: "3/2025"=Y2503 (năm 2025), "3/2026"=Y2603 (năm 2026) — KHÁC NHAU!
⛔ QUY TẮC BẮT BUỘC: Khi user nói rõ năm (VD: "06/2025", "tháng 6 năm 2025"), PHẢI dùng đúng năm đó. TUYỆT ĐỐI không thay bằng năm hiện tại. "06/2025" → Y2506 (KHÔNG PHẢI Y2606).
Dải tháng: "06/2025 đến 08/2025" = "Y2506,Y2507,Y2508" (năm 2025, KHÔNG phải Y2606,Y2607,Y2608)
Dải tháng: "07/2025 đến 12/2025" = "Y2507,Y2508,Y2509,Y2510,Y2511,Y2512"
Dải tháng: "01/2025 đến 03/2025" = "Y2501,Y2502,Y2503"
Dải tháng: "08/2025 đến 02/2026" = "Y2508,Y2509,Y2510,Y2511,Y2512,Y2601,Y2602"

⛔ TUYỆT ĐỐI KHÔNG TỰ TẠO SỐ LIỆU: Khi user hỏi về dữ liệu sale / saleout / số bán ra, LUÔN gọi read_saleout_table. KHÔNG bao giờ tự tính hoặc bịa số liệu. Số liệu bịa sẽ gây sai lệch nghiêm trọng.

⚠️ QUAN TRỌNG:
- Bạn có DỮ LIỆU THỰC (xem "DỮ LIỆU DASHBOARD"). Trả lời trực tiếp — KHÔNG bảo user "xem bảng".
- "TOP SẢN PHẨM LỖI NHIỀU NHẤT" trong system message = toàn bộ dữ liệu CHƯA lọc theo câu hỏi. KHÔNG dùng để trả lời câu hỏi có filter tháng/SP cụ thể.
- Khi hỏi "model/sản phẩm nào lỗi nhiều nhất" (toàn kỳ, không filter) → đọc TOP SẢN PHẨM trong system message → reply trực tiếp.
- Khi hỏi "tháng X, model nào lỗi nhiều nhất" → PHẢI filter_month rồi gọi read_top_products(by=errors). KHÔNG dùng dữ liệu trong system message.
- Khi hỏi "model nào saleout/bán nhiều nhất" / "saleout lớn nhất" → filter_month (nếu có tháng) + read_top_products(by=sale). KHÔNG dùng read_saleout_table.
- Khi hỏi "dữ liệu saleout năm X" / "saleout từng tháng" → switch_sub_tab(rate) + read_saleout_table({year:X}). read_saleout_table trả về THEO THÁNG, KHÔNG phải theo sản phẩm.
- Khi hỏi "bao nhiêu lỗi tổng" → switch_sub_tab(data) + clear_filters + filter + sum_errors. Để "reply":"".
- Khi hỏi "tỷ lệ lỗi/TLL%" → switch_sub_tab(rate) + clear_filters + filter + sum_rate. Để "reply":"".
- Khi hỏi "so sánh tháng X với Y", "có bất thường không", "xu hướng", "tăng giảm" → switch_sub_tab(rate) + analyze_trend. KHÔNG cần clear_filters trước. Để "reply":"".
- Khi hỏi "nhóm lỗi", "loại lỗi", "linh kiện lỗi", "nguyên nhân lỗi", "lỗi nào phổ biến" → switch_sub_tab(dashboard) + read_dashboard_groups(by=...). Để "reply":"".
- KHÔNG tự tính trong reply từ BẢNG THÁNG. Chỉ dùng sum_errors / sum_rate / analyze_trend / read_top_products / read_dashboard_groups.
- Mỗi câu hỏi là ĐỘC LẬP. Luôn gọi clear_filters trước khi áp filter mới (trừ analyze_trend).

⛔ CẤM TUYỆT ĐỐI (sẽ gây lỗi nghiêm trọng):
- switch_main_tab: CHỈ khi user gõ đúng "SPM1" hoặc "SPM2" hoặc "chuyển dataset".
- set_top_n: CHỈ khi user gõ "top N" / "hiển thị N sản phẩm". Câu hỏi về số lỗi KHÔNG cần set_top_n.
- set_sort_order: CHỈ khi user yêu cầu sắp xếp rõ ràng.
- BỎ SÓT filter_product: Khi user đề cập "model X" / "SP X" / "sản phẩm X" KÈM THEO phân tích xu hướng/lọc tháng, LUÔN thêm filter_product("X") TRƯỚC analyze_trend/filter_month. KHÔNG được bỏ qua.

Ví dụ đầy đủ (bao gồm chuyển tab tự động):
"tỷ lệ lỗi tháng 6/2026" → switch_sub_tab(rate) + clear_filters + filter_month(Y2606) + sum_rate, "reply":""
"tổng lỗi tháng 6/2026" → switch_sub_tab(data) + clear_filters + filter_month(Y2606) + sum_errors, "reply":""
"nhóm lỗi nào nhiều nhất" → switch_sub_tab(dashboard) + read_dashboard_groups(by=category,limit=10), "reply":""
"loại lỗi gì nhiều nhất" / "linh kiện lỗi phổ biến nhất" → switch_sub_tab(dashboard) + read_dashboard_groups(by=accessory,limit=10), "reply":""
"nguyên nhân lỗi chính" → switch_sub_tab(dashboard) + read_dashboard_groups(by=cause,limit=5), "reply":""
"tháng 3/2026 nhóm lỗi nào nhiều nhất" → switch_sub_tab(dashboard) + clear_filters + filter_month(Y2603) + read_dashboard_groups(by=category,limit=5), "reply":""
"xu hướng TLL% 6 tháng gần nhất" → switch_sub_tab(rate) + filter_month + analyze_trend, "reply":""
"phân tích xu hướng model S68 từ 06/2025-11/2025" → switch_sub_tab(rate) + clear_filters + filter_product("S68") + filter_month("Y2506,Y2507,Y2508,Y2509,Y2510,Y2511") + analyze_trend({"months":["Y2506","Y2507","Y2508","Y2509","Y2510","Y2511"]}), "reply":""
"xu hướng lỗi SP S66 năm 2025" → switch_sub_tab(rate) + clear_filters + filter_product("S66") + filter_month("Y2501,Y2502,...,Y2512") + analyze_trend({"months":["Y2501",...,"Y2512"]}), "reply":""
"TLL% model S88 3 tháng gần nhất" → switch_sub_tab(rate) + clear_filters + filter_product("S88") + filter_month(3 tháng cuối) + analyze_trend, "reply":""
"model/sản phẩm nào lỗi nhiều nhất" (không có tháng cụ thể) → switch_sub_tab(data) + clear_filters + read_top_products(by=errors), "reply":""
"tháng 04/2025, model nào nhiều lỗi nhất" → switch_sub_tab(data) + clear_filters + filter_month(Y2504) + read_top_products(by=errors,limit=5), "reply":""
"tháng 3/2026 SP nào TLL% cao nhất" → switch_sub_tab(rate) + clear_filters + filter_month(Y2603) + read_top_products(by=rate,limit=5), "reply":""
"TLL% cao nhất (toàn kỳ)" → switch_sub_tab(rate) + clear_filters + read_top_products(by=rate,limit=5), "reply":""
"model nào saleout nhiều nhất" (toàn kỳ) → switch_sub_tab(rate) + clear_filters + read_top_products(by=sale,limit=10), "reply":""
"từ 07/2025 đến 02/2026 model nào saleout lớn nhất" → switch_sub_tab(rate) + clear_filters + filter_month("Y2507,Y2508,Y2509,Y2510,Y2511,Y2512,Y2601,Y2602") + read_top_products(by=sale,limit=10), "reply":""
"tháng 6/2025 SP nào bán chạy nhất" → switch_sub_tab(rate) + clear_filters + filter_month(Y2506) + read_top_products(by=sale,limit=10), "reply":""
"SP S66 có bao nhiêu lỗi" → switch_sub_tab(data) + clear_filters + filter_product("S66") + sum_errors, "reply":""
"chi tiết lỗi model S88" / "danh sách lỗi SP S88" / "S88 lỗi gì" / "các lỗi của S88" → switch_sub_tab(dashboard) + clear_filters + filter_product("S88") + read_dashboard_groups(by=category,limit=10), "reply":""
"linh kiện lỗi của model S66" → switch_sub_tab(dashboard) + clear_filters + filter_product("S66") + read_dashboard_groups(by=accessory,limit=10), "reply":""
"tháng 4/2025 model S88 lỗi gì nhiều nhất" → switch_sub_tab(dashboard) + clear_filters + filter_product("S88") + filter_month(Y2504) + read_dashboard_groups(by=category,limit=10), "reply":""
"tỷ lệ lỗi SP S66 năm 2025" → switch_sub_tab(rate) + clear_filters + filter_product("S66") + filter_month("Y2501,...,Y2512") + sum_rate, "reply":""
"từ 08/2025 đến 02/2026 có bao nhiêu lỗi" → switch_sub_tab(data) + clear_filters + filter_month("Y2508,Y2509,Y2510,Y2511,Y2512,Y2601,Y2602") + sum_errors, "reply":""
"lọc từ 01/2025 đến 04/2025" → clear_filters + filter_month("Y2501,Y2502,Y2503,Y2504") → reply: "Đã lọc tháng 1–4/2025."
"SP S66 từ 07-12/2025 có bao nhiêu lỗi" → switch_sub_tab(data) + clear_filters + filter_product("S66") + filter_month("Y2507,Y2508,Y2509,Y2510,Y2511,Y2512") + sum_errors, "reply":""
"tổng số lượng lỗi 6 tháng đầu năm 2025" / "tổng lỗi nửa đầu năm 2025" / "6 tháng đầu 2025 có bao nhiêu lỗi" → switch_sub_tab(data) + clear_filters + filter_month("Y2501,Y2502,Y2503,Y2504,Y2505,Y2506") + sum_errors, "reply":""
"tổng lỗi 6 tháng cuối năm 2025" / "nửa cuối năm 2025" → switch_sub_tab(data) + clear_filters + filter_month("Y2507,Y2508,Y2509,Y2510,Y2511,Y2512") + sum_errors, "reply":""
"quý 1 năm 2025 có bao nhiêu lỗi" / "Q1 2025" → switch_sub_tab(data) + clear_filters + filter_month("Y2501,Y2502,Y2503") + sum_errors, "reply":""
"quý 2 năm 2025" → filter_month("Y2504,Y2505,Y2506") | "quý 3 năm 2025" → filter_month("Y2507,Y2508,Y2509") | "quý 4 năm 2025" → filter_month("Y2510,Y2511,Y2512")
"3 tháng đầu năm 2026" → filter_month("Y2601,Y2602,Y2603") | "4 tháng đầu năm 2026" → filter_month("Y2601,Y2602,Y2603,Y2604")
"top 5" → set_top_n(5) → reply: "Đã hiển thị Top 5 sản phẩm."
"tháng nào lỗi nhiều nhất" → switch_sub_tab(rate) + đọc BẢNG THÁNG → reply tháng có lỗi cao nhất
"tháng 3/2025 vs tháng 4/2026 có bất thường không" → switch_sub_tab(rate) + filter_month("Y2503,Y2604") + analyze_trend({"months":["Y2503","Y2604"]}), "reply":""
"xu hướng TLL% từ đầu năm 2026" → switch_sub_tab(rate) + filter_month("Y2601,Y2602,Y2603,...") + analyze_trend({"months":["Y2601","Y2602","Y2603",...]}), "reply":""
"6 tháng gần nhất có gì lạ không" → switch_sub_tab(rate) + filter_month với 6 tháng cuối + analyze_trend, "reply":""
"so sánh SP S66 tháng 3/2025 và 3/2026" → switch_sub_tab(rate) + filter_product("S66") + filter_month("Y2503,Y2603") + analyze_trend({"months":["Y2503","Y2603"]}), "reply":""
"sale out tháng 5" → switch_sub_tab(rate) + clear_filters + filter_month(Y2605) + sum_rate, "reply":""
"dữ liệu chi tiết tháng 4" → switch_sub_tab(data) + clear_filters + filter_month(Y2604), reply: "Đã chuyển sang tab Dữ liệu chi tiết và lọc tháng 4."
"dữ liệu sale out năm 2025" → switch_sub_tab(rate) + read_saleout_table({year: 2025}), "reply":""
"dữ liệu saleout năm 2026" → switch_sub_tab(rate) + read_saleout_table({year: 2026}), "reply":""
"sale out tháng 3/2025" → switch_sub_tab(rate) + read_saleout_table({months:["Y2503"]}), "reply":""
"tổng bán ra năm 2025" → switch_sub_tab(rate) + read_saleout_table({year: 2025}), "reply":""
"bán ra tháng 6/2025 đến 12/2025" → switch_sub_tab(rate) + read_saleout_table({months:["Y2506","Y2507","Y2508","Y2509","Y2510","Y2511","Y2512"]}), "reply":""
"so sánh sale out 2025 vs 2026" → switch_sub_tab(rate) + read_saleout_table({year:2025}): đọc 2025, sau đó read_saleout_table({year:2026}): đọc 2026, "reply": tổng hợp so sánh
"saleout cho model S688" → switch_sub_tab(rate) + clear_filters + filter_product("S688") + read_saleout_table({}), "reply":""
"sale out SP S66 năm 2025" → switch_sub_tab(rate) + clear_filters + filter_product("S66") + read_saleout_table({year:2025}), "reply":""
"tổng bán ra model KAE-S695 từ 07/2025 đến 12/2025" → switch_sub_tab(rate) + clear_filters + filter_product("KAE-S695") + read_saleout_table({months:["Y2507","Y2508","Y2509","Y2510","Y2511","Y2512"]}), "reply":""
⚠️ THỨ TỰ BẮT BUỘC khi đọc saleout theo sản phẩm: filter_product PHẢI đứng TRƯỚC read_saleout_table. Sai thứ tự → dữ liệu sẽ là toàn bộ dataset không lọc.
⚠️ HỎI TIẾP THEO VỀ NĂM/THÁNG SAU CÂU SALEOUT: PHẢI gọi read_saleout_table — KHÔNG chỉ filter_month rồi đọc BẢNG THÁNG (snapshot lạc hậu):
"năm 2026 thì sao" / "còn năm 2026" (sau câu saleout) → switch_sub_tab(rate) + read_saleout_table({year:2026}), "reply": tổng hợp từ kết quả
"năm 2025 thế nào" / "còn năm 2025" (sau câu saleout) → switch_sub_tab(rate) + read_saleout_table({year:2025}), "reply": tổng hợp từ kết quả
"tháng 3/2026 thì sao" (sau câu saleout) → switch_sub_tab(rate) + read_saleout_table({months:["Y2603"]}), "reply": tổng hợp
❌ SAI: chỉ gọi filter_month rồi trả lời từ BẢNG THÁNG khi câu hỏi liên quan đến saleout/bán ra
"hi" → {"actions":[],"reply":"Xin chào! Tôi có thể lọc dữ liệu, sắp xếp, hoặc trả lời câu hỏi về số liệu."}
⚠️ KHI USER NHẬP SAI HOẶC NGOÀI PHẠM VI:
- Năm không hợp lệ (ví dụ: 1015, 3000, 999...) → KHÔNG gọi tools, reply: "Năm [X] không hợp lệ. Dữ liệu hiện có từ 01/2025 đến nay. Bạn muốn xem năm 2025 hay 2026?"
- Tháng không tồn tại (tháng 13, tháng 0...) → reply giải thích, đề xuất tháng gần nhất
- Yêu cầu mơ hồ hoặc không liên quan đến dashboard → reply hỏi lại hoặc giải thích không tìm thấy dữ liệu`;

  // ── Model rotation — 6 model, ưu tiên theo TPM giảm dần, tự động chuyển khi hết quota ──
  // groq/compound và groq/compound-mini là orchestrator models, context window nhỏ → request_too_large
  const GROQ_MODELS = [
    // Tier 1: 30K TPM, 500K TPD
    'meta-llama/llama-4-scout-17b-16e-instruct',
    // Tier 2: 12K TPM, 100K TPD
    'llama-3.3-70b-versatile',
    // Tier 3: 8K TPM, 200K TPD
    'openai/gpt-oss-120b',
    'qwen/qwen3.6-27b',
    // Tier 4: 6K TPM, 500K TPD
    'qwen/qwen3-32b',
    'llama-3.1-8b-instant',
  ];
  const _skipModels = new Set(); // models bị lỗi/hết quota trong session

  function _nextModel() {
    return GROQ_MODELS.find(m => !_skipModels.has(m)) || null;
  }

  function _shouldSkipModel(status, body) {
    if (status === 429) return body.includes('per day') || body.includes('TPD');
    // 413 có 2 nghĩa: "per minute" exceeded → retry; còn lại → request quá lớn cho model này → switch
    if (status === 413) return !body.includes('per minute');
    if (status === 400) return body.includes('decommissioned') || body.includes('no longer supported');
    return false;
  }

  // ── Groq API — JSON mode, model rotation + exponential backoff ───────────
  async function _callGroq(userText, onActionStep, onDisambiguate) {
    _disambiguateCallback = onDisambiguate || null;
    const key = APP_CONFIG.chatbot?.groqApiKey;
    const hasWorker = APP_CONFIG.chatbot?.groqWorkerUrl && !APP_CONFIG.chatbot.groqWorkerUrl.includes('YOUR-WORKER');
    if (!key && !hasWorker) return null;

    const messages = [
      { role: 'system', content: _buildSystemMessage() },
      { role: 'user', content: userText },
    ];

    const RETRY_DELAYS = [4000, 12000, 35000]; // backoff cho TPM (per-minute)
    let data;

    // Vòng ngoài: thử từng model theo thứ tự ưu tiên
    while (true) {
      const model = _nextModel();
      if (!model) throw new Error('ALL_MODELS_EXHAUSTED');

      // Vòng trong: retry TPM cho model hiện tại
      let switched = false;
      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        // Dùng Cloudflare Worker proxy nếu có — key ẩn phía server, không lộ trong browser
        const workerUrl = APP_CONFIG.chatbot?.groqWorkerUrl;
        const useProxy = workerUrl && !workerUrl.includes('YOUR-WORKER');
        const apiUrl = useProxy ? workerUrl : 'https://api.groq.com/openai/v1/chat/completions';
        const apiHeaders = useProxy
          ? { 'Content-Type': 'application/json' }
          : { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: apiHeaders,
          body: JSON.stringify({
            model,
            messages,
            max_tokens: 420,
            response_format: { type: 'json_object' },
          }),
        });

        if (!res.ok) {
          const errBody = await res.text();
          if (_shouldSkipModel(res.status, errBody)) {
            // Model không dùng được (hết TPD hoặc bị tắt) → chuyển model tiếp theo
            _skipModels.add(model);
            const next = _nextModel();
            onActionStep?.({
              tool: '_retry',
              input: { note: `${model} không khả dụng → chuyển sang ${next || 'hết model'}` },
              status: next ? 'running' : 'error',
            });
            if (next) onActionStep?.({ tool: '_retry', input: {}, status: 'done' });
            switched = true;
            break;
          }
          if (res.status === 429 || (res.status === 413 && errBody.includes('per minute'))) {
            // 429 = TPM rate limit | 413 + "per minute" = TPM exceeded (Groq đôi khi báo dạng 413)
            if (attempt >= RETRY_DELAYS.length) throw new Error(`Groq API ${res.status}: ${errBody.slice(0, 300)}`);
            // Parse "try again in 7.16s" từ error body để chờ đúng thời gian thay vì fixed delay
            const retryMatch = errBody.match(/try again in (\d+\.?\d*)s/i);
            const wait = retryMatch ? Math.ceil(parseFloat(retryMatch[1]) * 1000) + 1000 : RETRY_DELAYS[attempt];
            onActionStep?.({ tool: '_retry', input: { attempt: attempt + 1, wait }, status: 'running' });
            await new Promise(r => setTimeout(r, wait));
            onActionStep?.({ tool: '_retry', input: {}, status: 'done' });
            continue;
          }
          if (res.status === 400 && (errBody.includes('failed_generation') || errBody.includes('json_validate_failed') || errBody.includes('generate JSON') || errBody.includes('validate JSON'))) {
            // Model không tạo được JSON hợp lệ → retry 1 lần, nếu vẫn fail thì chuyển model
            if (attempt === 0) {
              await new Promise(r => setTimeout(r, 1500));
              continue;
            }
            _skipModels.add(model);
            const next = _nextModel();
            onActionStep?.({ tool: '_retry', input: { note: `${model} lỗi JSON → chuyển sang ${next || 'hết model'}` }, status: next ? 'running' : 'error' });
            if (next) onActionStep?.({ tool: '_retry', input: {}, status: 'done' });
            switched = true;
            break;
          }
          if (res.status === 403 || res.status === 401) {
            // 403 có thể model-gated (free tier limit) → thử model tiếp theo trước
            _skipModels.add(model);
            const next = _nextModel();
            onActionStep?.({ tool: '_retry', input: { note: `${model} → 403, thử ${next || 'hết model'}` }, status: next ? 'running' : 'error' });
            if (next) onActionStep?.({ tool: '_retry', input: {}, status: 'done' });
            switched = true;
            break;
          }
          throw new Error(`Groq API ${res.status}: ${errBody.slice(0, 160)}`);
        }

        data = await res.json();
        break;
      }
      if (!switched) break;
    }

    // Parse JSON response
    const raw = data?.choices?.[0]?.message?.content || '{}';
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch (_) {
      const m = raw.match(/\{[\s\S]*\}/);
      try { parsed = JSON.parse(m?.[0] || '{}'); } catch (_) {}
    }

    // Normalize actions: một số model dùng key "tool"/"function" thay vì "name", hoặc trả về string
    // Một số model trả về "switch_sub_tab(rate)" thay vì {name:"switch_sub_tab", args:{tab:"rate"}}
    const rawActions = (Array.isArray(parsed.actions) ? parsed.actions : [])
      .map(a => {
        if (!a) return null;
        if (typeof a === 'string') return { name: a.replace(/\(.*\)$/, '').trim(), args: {} };
        let name = a.name || a.tool || a.function || a.action || '';
        let args = a.args || a.parameters || a.input || {};
        // Strip parenthetical suffix: "switch_sub_tab(rate)" → "switch_sub_tab"
        if (name.includes('(')) name = name.replace(/\(.*\)$/, '').trim();
        return { name, args };
      })
      .filter(a => a && typeof a.name === 'string' && a.name.length > 0);
    const reply      = (parsed.reply || '').trim();

    // Chặn action bị hallucinate dựa vào nội dung câu hỏi của user
    const lower = (userText || '').toLowerCase();
    const allowSwitch  = /\bspm1\b|\bspm2\b|chuyển dataset|thiết kế mới|tất cả lỗi linh kiện/.test(lower);
    const allowTopN    = /\btop\s*\d|\bhiển thị\s+\d/.test(lower);
    const allowSort    = /sắp xếp|giảm dần|tăng dần/.test(lower);
    // filter_product: chỉ cho phép khi user đề cập đến sản phẩm/SP/model cụ thể
    const allowProduct = /lọc\s*(sp|sản phẩm|model)|sản phẩm|tên sp|\bsp\b|\bmodel\b|kae|kad|kaq|kah|platinum|livotec|wpk|\bs\d{2,}\b/.test(lower);
    const actions = rawActions.filter(a => {
      if (a.name === 'switch_main_tab' && !allowSwitch)  return false;
      // switch_sub_tab: cho phép AI tự động chuyển tab theo ngữ cảnh câu hỏi
      if (a.name === 'set_top_n'       && !allowTopN)    return false;
      if (a.name === 'set_sort_order'  && !allowSort)    return false;
      if (a.name === 'filter_product'  && !allowProduct) return false;
      return true;
    });

    // Auto-prepend clear_filters trước mỗi filter query để xoá state cũ
    // (AI đôi khi quên gọi clear_filters → filter cũ còn lại → kết quả sai)
    const hasNewFilter = actions.some(a => a.name === 'filter_month' || a.name === 'filter_product');
    const hasExplicitClear = actions.some(a => a.name === 'clear_filters');
    if (hasNewFilter && !hasExplicitClear) {
      actions.unshift({ name: 'clear_filters', args: {} });
    }

    // Đảm bảo clear_filters luôn đứng TRƯỚC mọi filter_* (AI đôi khi đặt sai thứ tự khi user nói "tất cả")
    const clearIdx   = actions.findIndex(a => a.name === 'clear_filters');
    const firstFilterIdx = actions.findIndex(a => a.name === 'filter_month' || a.name === 'filter_product');
    if (clearIdx !== -1 && firstFilterIdx !== -1 && clearIdx > firstFilterIdx) {
      const [clearAction] = actions.splice(clearIdx, 1);
      actions.splice(firstFilterIdx, 0, clearAction);
    }

    // Đảm bảo các "read" tools luôn chạy SAU tất cả filter_* (tránh đọc trước khi filter được áp dụng)
    const READ_TOOLS = new Set(['read_saleout_table','read_top_products','read_dashboard_groups','sum_errors','sum_rate','analyze_trend']);
    const nonReadActions = actions.filter(a => !READ_TOOLS.has(a.name));
    const readActions    = actions.filter(a =>  READ_TOOLS.has(a.name));
    actions.length = 0;
    actions.push(...nonReadActions, ...readActions);

    // Thực thi actions
    const toolResults = [];
    let sumResult = null;
    for (const action of actions) {
      const name = action.name;
      const args = action.args || {};
      onActionStep?.({ tool: name, input: args, status: 'running' });
      const exec   = EXECUTORS[name];
      const result = exec ? await exec(args) : `Action "${name}" không tồn tại`;
      onActionStep?.({ tool: name, input: args, status: 'done', result });
      toolResults.push(result);
      if (['sum_errors','sum_rate','analyze_trend','read_top_products','read_dashboard_groups','read_saleout_table'].includes(name)) sumResult = result;
    }

    // sum_errors luôn override reply của AI (AI tính trước khi filter xong → sai)
    const actionsRan = toolResults.length > 0;
    const text = sumResult || reply || toolResults.filter(Boolean).join('\n')
      || (actionsRan ? 'Đã thực hiện.' : 'Xin lỗi, tôi chưa hiểu yêu cầu này. Bạn có thể hỏi lại hoặc thử diễn đạt khác không?');
    return { text, toolResults };
  }

  // ── Main sendMessage (Groq-only) ─────────────────────────────────────────
  async function sendMessage(userText, { onActionStep, onDisambiguate } = {}) {
    const hasKey = !!APP_CONFIG.chatbot?.groqApiKey;
    const hasWorker = APP_CONFIG.chatbot?.groqWorkerUrl && !APP_CONFIG.chatbot.groqWorkerUrl.includes('YOUR-WORKER');
    if (!hasKey && !hasWorker) {
      return { source: 'none', message: 'Chưa cấu hình Groq API key hoặc Worker URL trong appConfig.js.' };
    }
    try {
      const result = await _callGroq(userText, onActionStep, onDisambiguate);
      _history.push(
        { role: 'user',  parts: [{ text: userText }] },
        { role: 'model', parts: [{ text: result.text }] },
      );
      if (_history.length > 20) _history = _history.slice(-20);
      return { source: 'groq', message: result.text };
    } catch (err) {
      console.error('[ChatbotService]', err);
      if (err.message === 'ALL_MODELS_EXHAUSTED') {
        return { source: 'error', message: '⛔ Tất cả 6 model AI đã hết hạn mức token ngày (Groq free tier).\n\nQuota reset lúc 0:00 UTC (7:00 sáng giờ VN). Vui lòng thử lại sau.' };
      }
      if (err.message === 'KEY_INVALID') {
        return { source: 'error', message: '⛔ Tất cả model đều trả về 403 — Groq API key không hợp lệ hoặc đã bị thu hồi.\n\nKiểm tra: groq.com → API Keys → xem key còn Active không. Nếu Revoked → tạo key mới và cập nhật Cloudflare Worker Secrets.' };
      }
      if (err.message.includes('429')) {
        const retryMatch = err.message.match(/try again in (\d+)m/i);
        if (retryMatch && parseInt(retryMatch[1]) > 5) {
          const mins = retryMatch[1];
          return { source: 'error', message: `⛔ Model hiện tại hết hạn mức ngày. Reset sau khoảng ${mins} phút.` };
        }
        return { source: 'error', message: '⚠️ AI đang quá tải tạm thời. Hệ thống đã thử 3 lần. Vui lòng đợi 1–2 phút rồi thử lại.' };
      }
      return { source: 'error', message: `Lỗi kết nối AI: ${err.message}` };
    }
  }

  function clearHistory() { _history = []; }

  return { sendMessage, clearHistory };
})();
