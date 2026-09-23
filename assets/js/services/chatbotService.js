const ChatbotService = (() => {
  'use strict';

  let _history = [];
  let _lastProductFilterError = null; // flag cho read_dashboard_groups biết filter_product có thất bại không
  let _disambiguateCallback   = null; // callback để UI hiện disambiguation popup khi có nhiều match
  let _groqKeyDirect   = null;         // key load từ NocoDB, dùng để gọi Groq trực tiếp từ browser
  let _geminiKeyDirect = null;         // key load từ NocoDB, dùng để gọi Gemini trực tiếp từ browser

  // Track filter state trong chatbot — phòng trường hợp SaleOutRenderer bị reset async
  let _chatbotMonths   = [];  // months đã set bởi filter_month trong turn hiện tại
  let _chatbotProducts = [];  // products đã set bởi filter_product
  let _lastUserText    = '';  // user message của turn hiện tại — dùng để auto-correct args khi AI nhỏ sai

  // Load API keys từ NocoDB config table (chạy 1 lần khi app khởi động)
  async function loadKey() {
    try {
      const groqStored = await DataService.configGet('groq_api_key');
      if (groqStored && typeof groqStored === 'string' && groqStored.length > 20) {
        _groqKeyDirect = groqStored;
        console.log('[ChatbotService] Groq key loaded from NocoDB');
      }
      const geminiStored = await DataService.configGet('gemini_api_key');
      if (geminiStored && typeof geminiStored === 'string' && geminiStored.length > 20) {
        _geminiKeyDirect = geminiStored;
        console.log('[ChatbotService] Gemini key loaded from NocoDB');
      }
    } catch (e) {
      console.warn('[ChatbotService] Không load được key từ NocoDB:', e.message);
    }
  }

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
  // Chuẩn hóa nhiều format → Ymmyy: "07/2026","07-2026","07.2026","7/26","tháng 7 2026" → "Y2607"
  function _normalizeMonthCode(raw) {
    if (!raw) return null;
    raw = raw.trim();
    if (/^Y\d{4}$/.test(raw)) return raw; // đã đúng format
    // 07/2026, 07-2026, 07.2026, 7/2026, 7-2026, 07 2026
    let m = raw.match(/^(\d{1,2})[\/\-\.\s](\d{4})$/);
    if (m) return `Y${m[2].slice(-2)}${m[1].padStart(2, '0')}`;
    // 2026/07, 2026-07
    m = raw.match(/^(\d{4})[\/\-\.](\d{1,2})$/);
    if (m) return `Y${m[1].slice(-2)}${m[2].padStart(2, '0')}`;
    // tháng 7/2026, tháng 07/2026
    m = raw.match(/th[aá]ng\s*(\d{1,2})[\/\-\.\s]*(\d{4})/i);
    if (m) return `Y${m[2].slice(-2)}${m[1].padStart(2, '0')}`;
    return raw;
  }

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
    const safeTab = tab || 'rate';
    const LABELS   = { rate: 'Tỷ lệ lỗi', data: 'Dữ liệu chi tiết', pivot: 'Phân tích', dashboard: 'Biểu đồ chi tiết lỗi' };
    const SECTIONS = { rate: 'saleout', data: 'saleout', pivot: 'pivot', dashboard: 'dashboard' };
    const IDS      = { rate: 'subtab-saleout-rate', data: 'subtab-saleout-data', pivot: 'subtab-pivot', dashboard: 'subtab-dashboard' };

    const section = SECTIONS[safeTab];
    if (section && typeof window._mainActivateTab === 'function') {
      // Gọi trực tiếp hàm activate — đảm bảo _activeSection được cập nhật ngay, không phụ thuộc vào click event
      window._mainActivateTab(section);
      // Visual: ripple trên button tương ứng
      const el = document.getElementById(IDS[safeTab]);
      if (el) { _spawnRipple(el); _showActionLabel(el, `AI: ${LABELS[safeTab] || safeTab}`); }
    } else {
      const el = document.getElementById(IDS[safeTab]);
      await _simulateClick(el, `AI: Chuyển sang tab ${LABELS[safeTab] || safeTab}`);
    }
    if (safeTab === 'dashboard') await _delay(500); // chờ dashboard render xong
    return `Đã chuyển sang tab ${LABELS[safeTab] || safeTab}`;
  }

  function _isDashboard() {
    return (window.AppState?.getSummary?.()?.activeSection) === 'dashboard';
  }

  async function _execFilterProduct({ query }) {
    // Strip Vietnamese product prefixes mà AI nhỏ hay gửi kèm ("máy S688" → "S688")
    const _stripPrefixes = (s) => s
      .replace(/^(?:máy|model\s+|sản phẩm\s+|sp\s+|thiết bị\s+|dòng\s+|loại\s+)/i, '')
      .trim();
    const raw = (query || '').toLowerCase().trim();
    const q   = _stripPrefixes(raw);
    if (!q) return 'Vui lòng chỉ định tên hoặc mã sản phẩm cụ thể';

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
    if (!pills.length) return `Không tìm thấy sản phẩm khớp với "${q}" trong dữ liệu hiện tại`;
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
    _chatbotProducts = next; // track để re-apply nếu SaleOutRenderer.setData() reset async
    SaleOutRenderer.setProductFilter(next);
    _spawnRipple(pill);
    _showActionLabel(pill, `AI: Chọn sản phẩm "${productName}"`);
    await _delay(200);
    return `Đã lọc sản phẩm: ${productName}`;
  }

  async function _execFilterMonth({ month }) {
    // AI có thể trả về: string, array, "Y2507", "07/2026", năm "2026"/"26"
    let rawList;
    if (Array.isArray(month)) {
      rawList = month.map(m => String(m).trim()).filter(Boolean);
    } else {
      rawList = (String(month || '')).split(',').map(m => m.trim()).filter(Boolean);
    }

    // Expand năm → 12 tháng (VD: "2026" → [Y2601..Y2612], "26" → [Y2601..Y2612])
    rawList = rawList.flatMap(raw => {
      const yearMatch = raw.match(/^(?:20)?(\d{2})$/);
      if (yearMatch && !raw.includes('/') && !raw.includes('-') && !raw.includes('.')) {
        const yy = yearMatch[1];
        return Array.from({ length: 12 }, (_, i) => `Y${yy}${String(i + 1).padStart(2, '0')}`);
      }
      return [raw];
    });

    const incoming = rawList.map(m => _normalizeMonthCode(m)).filter(Boolean);
    if (!incoming.length) return 'Không xác định được tháng';

    // Validate nhẹ: cảnh báo nếu tháng không tồn tại trong dữ liệu, nhưng vẫn set filter
    const availableMonths = (window.AppState?.getDashboardSummary?.()?.uniqueMonths)
      || (window.AppState?.getSummary?.()?.tableByMonth || []).map(r => r.month);
    let validationWarning = '';
    if (availableMonths.length) {
      const missing = incoming.filter(m => !availableMonths.includes(m));
      if (missing.length === incoming.length) {
        const hint = availableMonths.slice(0, 8).join(', ');
        validationWarning = ` (lưu ý: tháng ${missing.slice(0, 3).join(', ')}... chưa có dữ liệu. Tháng có dữ liệu: ${hint})`;
      }
    }

    if (_isDashboard()) {
      // Dashboard tab: dùng SlicerService cho field month
      SlicerService.setFieldFilter('month', incoming);
      DashboardRenderer?.render?.();
      await _delay(150);
      return `Đã lọc dashboard theo tháng: ${incoming.join(', ')}${validationWarning}`;
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

    _chatbotMonths = next; // track để re-apply nếu SaleOutRenderer bị reset async
    SaleOutRenderer.setMonthFilter(next);

    // Visual feedback trên từng pill
    for (const m of incoming) {
      const pill = [...document.querySelectorAll('.so-pill[data-type="month"]')]
        .find(p => (p.dataset.value || '').trim() === m);
      if (pill) { _spawnRipple(pill); _showActionLabel(pill, `AI: Chọn tháng ${m}`); }
    }
    await _delay(250);
    return `Đã lọc tháng: ${next.join(', ')}${validationWarning}`;
  }

  async function _execClearFilters() {
    _lastProductFilterError = null;
    _chatbotMonths   = [];
    _chatbotProducts = [];
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

  // Re-apply filter nếu SaleOutRenderer bị reset bởi async event (setData resets _filters)
  function _ensureFilterApplied() {
    if (_isDashboard()) return; // dashboard dùng SlicerService, không cần check
    const current = SaleOutRenderer.getFilters?.() || { months: [], shortNames: [] };
    const needsMonth   = _chatbotMonths.length > 0 && current.months.length === 0;
    const needsProduct = _chatbotProducts.length > 0 && current.shortNames.length === 0;
    if (needsMonth)   SaleOutRenderer.setMonthFilter(_chatbotMonths);
    if (needsProduct) SaleOutRenderer.setProductFilter(_chatbotProducts);
  }

  // Đọc tổng lỗi từ dữ liệu SAU KHI filter đã được áp dụng
  async function _execSumErrors() {
    try {
      _ensureFilterApplied();
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
      _ensureFilterApplied();
      if (_isDashboard()) {
        return 'TLL% không tính được trên tab Biểu đồ (cần dữ liệu Sale Out từ tab Tỷ lệ lỗi)';
      }
      const s = window.AppState?.getSummary?.() || {};
      const rate = s.overallRate;
      const filterParts = [];
      if (s.selectedMonths?.length)   filterParts.push(`tháng ${s.selectedMonths.join(', ')}`);
      if (s.selectedProducts?.length) filterParts.push(`SP ${s.selectedProducts.join(', ')}`);
      const filterStr = filterParts.length ? `(${filterParts.join('; ')})` : '(toàn bộ)';
      if (rate !== null && rate !== undefined) {
        return `TLL% ${filterStr}: ${rate.toFixed(2)}%`;
      }
      // Giải thích cụ thể tại sao không tính được
      const byMonth = s.tableByMonth || [];
      const totalErrors = byMonth.reduce((a, r) => a + (r.errors || 0), 0);
      const missingMonths = byMonth.filter(r => (r.sale == null || r.sale === 0) && (r.errors || 0) > 0);
      const hasMonths = byMonth.filter(r => (r.sale || 0) > 0);
      const parts = [`⚠️ Chưa tính được TLL% ${filterStr}`];
      if (totalErrors > 0) parts.push(`Số lỗi ghi nhận: ${totalErrors}`);
      if (missingMonths.length) parts.push(`Thiếu Sale Out: ${missingMonths.map(r => _fmtMonth(r.month)).join(', ')} (${missingMonths.length} tháng)`);
      if (!missingMonths.length && !hasMonths.length) parts.push('Lý do: chưa import dữ liệu Sale Out');
      if (hasMonths.length) parts.push(`Đã có Sale Out: ${hasMonths.map(r => _fmtMonth(r.month)).join(', ')}`);
      return parts.join('\n');
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

      // Ưu tiên: months param → filter đang bật → tất cả tháng
      const targets = Array.isArray(months) && months.length
        ? months.filter(m => allByMonth.some(r => r.month === m))
        : savedMonths.length
          ? savedMonths.filter(m => allByMonth.some(r => r.month === m)).sort()
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

  // Lọc dashboard theo nhiều giá trị (OR logic) — dùng cho range query Time_sudung
  async function _execFilterFieldRange({ field, values }) {
    if (!_isDashboard()) { await _execSwitchSubTab({ tab: 'dashboard' }); await _delay(300); }
    const allVals = window.AppState?.getAllFieldValues?.(field) || [];
    const LABELS = { category: 'nhóm lỗi', err_accessory: 'linh kiện lỗi', cause: 'nguyên nhân', Time_sudung: 'mốc thời gian sử dụng' };
    // Normalize: bỏ khoảng trắng xung quanh dấu gạch ngang ("6- 12" → "6-12")
    const norm = s => s.toLowerCase().replace(/\s*-\s*/g, '-').trim();
    const matched = [];
    for (const val of values) {
      const q = norm(String(val));
      const m = allVals.find(v => norm(v) === q) ||
                allVals.find(v => norm(v).includes(q)) ||
                allVals.find(v => q.includes(norm(v)));
      if (m && !matched.includes(m)) matched.push(m);
    }
    if (!matched.length) return `Không tìm thấy giá trị nào trong ${LABELS[field] || field}`;
    SlicerService.setFieldFilter(field, matched);
    DashboardRenderer?.render?.();
    await _delay(300);
    const verify = window.AppState?.getDashboardSummary?.() || {};
    return `Đã lọc theo ${LABELS[field] || field}: ${matched.join(', ')} (${verify.filteredCount || 0} bản ghi)`;
  }

  // Lọc dashboard theo giá trị cụ thể của 1 field (category, err_accessory, cause, v.v.)
  async function _execFilterField({ field, value }) {
    if (!field || !value) return 'Thiếu field hoặc value để lọc';
    // Support array value cho range queries (e.g. Time_sudung nhiều mốc)
    if (Array.isArray(value)) return _execFilterFieldRange({ field, values: value });
    if (!_isDashboard()) {
      await _execSwitchSubTab({ tab: 'dashboard' });
      await _delay(300);
    }
    const q = String(value).toLowerCase().trim();
    const dash = window.AppState?.getDashboardSummary?.() || {};
    // Top-N results (nhanh, ưu tiên dùng trước)
    const FIELD_TOP = {
      category:      (dash.topByCategory  || []).map(r => r.name),
      err_accessory: (dash.topByAccessory || []).map(r => r.name),
      cause:         (dash.topByCause     || []).map(r => r.name),
      Time_sudung:   [],
    };
    // ALL unique values — dùng khi top-N không đủ (ví dụ: giá trị hiếm không vào top 10)
    const FIELD_ALL = {
      category:      window.AppState?.getAllFieldValues?.('category')      || [],
      err_accessory: window.AppState?.getAllFieldValues?.('err_accessory') || [],
      cause:         window.AppState?.getAllFieldValues?.('cause')         || [],
      Time_sudung:   window.AppState?.getAllFieldValues?.('Time_sudung')   || [],
    };
    const FIELD_LABELS = { category: 'nhóm lỗi', err_accessory: 'linh kiện lỗi', cause: 'nguyên nhân', Time_sudung: 'mốc thời gian sử dụng' };

    const _norm = s => s.toLowerCase().replace(/\s*-\s*/g, '-').trim();
    const _qn = _norm(q);
    // Tìm TẤT CẢ candidates khớp (dùng cho field chính — để disambiguate)
    const _findAll = (candidates) => {
      const exact   = candidates.filter(v => _norm(v) === _qn);
      const partial = candidates.filter(v => !exact.includes(v) &&
        (_norm(v).includes(_qn) || _qn.includes(_norm(v))));
      return [...exact, ...partial];
    };
    // Tìm match đầu tiên (dùng cho fallback fields — không cần popup)
    const _findIn = (candidates) =>
      candidates.find(v => _norm(v) === _qn) ||
      candidates.find(v => _norm(v).includes(_qn)) ||
      candidates.find(v => _qn.includes(_norm(v)));

    // Thứ tự thử: field AI chỉ định trước, sau đó category → err_accessory → cause
    const SEARCH_ORDER = [field, ...['category', 'err_accessory', 'cause'].filter(f => f !== field)];

    for (const tryField of SEARCH_ORDER) {
      let match;

      if (tryField === field) {
        // Field chính: tìm TẤT CẢ candidates, disambiguate nếu nhiều hơn 1
        const allVals = [...new Set([...(FIELD_TOP[tryField] || []), ...(FIELD_ALL[tryField] || [])])];
        const candidates = _findAll(allVals);
        if (!candidates.length) continue;

        if (candidates.length > 1 && typeof _disambiguateCallback === 'function') {
          match = await new Promise(resolve => _disambiguateCallback({ candidates, resolve }));
          if (!match) return 'Đã huỷ — không chọn giá trị';
        } else {
          match = candidates[0];
        }
      } else {
        // Fallback fields: chỉ lấy match đầu tiên, không popup
        match = _findIn(FIELD_TOP[tryField] || []) || _findIn(FIELD_ALL[tryField] || []);
      }

      if (!match) continue;

      // Áp filter và kiểm tra kết quả thực tế
      SlicerService.setFieldFilter(tryField, [match]);
      DashboardRenderer?.render?.();
      await _delay(300);

      const verify = window.AppState?.getDashboardSummary?.() || {};
      if ((verify.filteredCount || 0) > 0) {
        const label = FIELD_LABELS[tryField] || tryField;
        const note = tryField !== field
          ? ` (tự động sửa: "${FIELD_LABELS[field] || field}" → "${label}" vì có dữ liệu ở đây)`
          : '';
        return `Đã lọc dashboard theo ${label}: "${match}"${note}`;
      }

      // 0 kết quả → clear field này, thử field tiếp theo
      SlicerService.setFieldFilter(tryField, []);
      DashboardRenderer?.render?.();
      await _delay(100);
    }

    // Không field nào có dữ liệu
    const avail = [
      FIELD_TOP.category.length      ? `Nhóm lỗi: ${FIELD_TOP.category.slice(0, 6).join(', ')}` : '',
      FIELD_TOP.err_accessory.length ? `Linh kiện: ${FIELD_TOP.err_accessory.slice(0, 6).join(', ')}` : '',
      FIELD_TOP.cause.length         ? `Nguyên nhân: ${FIELD_TOP.cause.slice(0, 4).join(', ')}` : '',
    ].filter(Boolean).join('\n');
    return `Không tìm thấy "${value}" trong dữ liệu hiện tại.\n${avail || 'Không có dữ liệu với filter hiện tại.'}`;
  }

  // Đọc bảng nhóm lỗi / linh kiện lỗi / nguyên nhân / model từ dashboard SAU KHI filter đã áp dụng
  async function _execReadDashboardGroups({ by, limit }) {
    try {
      // Auto-switch về dashboard tab nếu AI đã gọi sai tab trước đó
      if (!_isDashboard()) await _execSwitchSubTab({ tab: 'dashboard' });

      // Auto-correct 'by' dựa vào user text thực tế — tránh AI 8B chọn sai parameter
      const uLower = _lastUserText.toLowerCase();
      if (/linh kiện|linh_kien|phụ kiện|phụ tùng|accessory|bộ phận/.test(uLower)) {
        by = 'accessory';
      } else if (/nguyên nhân|nguyen nhan|\bcause\b|lý do lỗi|tại sao lỗi/.test(uLower)
                 && !/model nào|sp nào|sản phẩm nào|máy nào/.test(uLower)) {
        by = 'cause';
      } else if (/model nào|sp nào|sản phẩm nào|máy nào|by=product/.test(uLower)) {
        by = 'product';
      }
      // else giữ nguyên by do AI trả về (thường là 'category')

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
      } else if (by === 'product' || by === 'model') {
        rows  = (dash.topByProduct || []).slice(0, n);
        label = 'Model/Sản phẩm';
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
      await _delay(100);
      _ensureFilterApplied();
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
    filter_field:          _execFilterField,
  };

  // Tạo system message kèm dữ liệu thực từ dashboard
  function _buildSystemMessage() {
    const s = window.AppState?.getSummary?.() || {};
    const filterParts = [];
    if (s.selectedMonths?.length)   filterParts.push(`tháng: ${s.selectedMonths.join(', ')}`);
    if (s.selectedProducts?.length) filterParts.push(`SP: ${s.selectedProducts.join(', ')}`);

    // Tính tháng hiện tại + các mốc tương đối (dùng giải nghĩa "tháng này", "tháng trước", v.v.)
    const _now = new Date();
    const _yy  = String(_now.getFullYear()).slice(-2);
    const _mm  = String(_now.getMonth() + 1).padStart(2, '0');
    const _curCode  = `Y${_yy}${_mm}`;
    const _prevDate = new Date(_now.getFullYear(), _now.getMonth() - 1, 1);
    const _prevCode = `Y${String(_prevDate.getFullYear()).slice(-2)}${String(_prevDate.getMonth() + 1).padStart(2, '0')}`;
    const _prev2Date = new Date(_now.getFullYear(), _now.getMonth() - 2, 1);
    const _prev2Code = `Y${String(_prev2Date.getFullYear()).slice(-2)}${String(_prev2Date.getMonth() + 1).padStart(2, '0')}`;
    // 3 tháng gần nhất (bao gồm tháng hiện tại)
    const _last3 = [_prev2Code, _prevCode, _curCode];
    // Tạo danh sách N tháng gần nhất tính ngược từ tháng hiện tại
    const _lastNMonths = (n) => {
      const result = [];
      for (let i = n - 1; i >= 0; i--) {
        const d = new Date(_now.getFullYear(), _now.getMonth() - i, 1);
        result.push(`Y${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, '0')}`);
      }
      return result;
    };
    const _timeCtx = [
      `Ngày hôm nay: ${_now.getDate()}/${_now.getMonth() + 1}/${_now.getFullYear()}`,
      `Tháng này = ${_curCode} | Tháng trước = ${_prevCode} | 2 tháng trước = ${_prev2Code}`,
      `3 tháng gần nhất = ${_last3.join(', ')} | 6 tháng gần nhất = ${_lastNMonths(6).join(', ')}`,
      `⏰ Khi user nói "tháng này"/"tháng hiện tại" → filter_month("${_curCode}")`,
      `⏰ "tháng trước" → filter_month("${_prevCode}")`,
      `⏰ "N tháng gần nhất" → filter_month(${JSON.stringify(_lastNMonths(3))}) (ví dụ N=3, tính tương tự với N khác)`,
    ].join('\n');

    const fmt = r => r.rate !== null && r.rate !== undefined ? r.rate.toFixed(2) + '%' : 'N/A';

    // Giới hạn 5 SP để giảm token (đủ cho câu hỏi tổng quan; chi tiết hơn dùng tools)
    const productLines = (s.tableByProduct || []).slice(0, 3).map((r, i) =>
      `${i + 1}. ${r.name}: lỗi=${r.errors} sale=${r.sale} TLL%=${fmt(r)}`
    ).join('\n');

    const errorRankLines = (s.tableByProductErrors || []).slice(0, 3).map((r, i) =>
      `${i + 1}. ${r.name}: lỗi=${r.errors} sale=${r.sale} TLL%=${fmt(r)}`
    ).join('\n');

    // Tất cả tháng có dữ liệu thực (sale>0 hoặc lỗi>0)
    const allUnfilteredMonths = window.AppState?.getAllMonthsData?.() || [];
    const allMonths = (allUnfilteredMonths.length ? allUnfilteredMonths : (s.tableByMonth || []));
    const activeMonthsForStats = allMonths.filter(r => (r.sale || 0) > 0 || (r.errors || 0) > 0);
    const monthLines = allMonths.slice(-6).map(r =>
      `${r.month}: lỗi=${r.errors} sale=${r.sale} TLL%=${fmt(r)}`
    ).join('\n');

    // Tính sẵn top/bottom để AI không cần tự tính (tránh hallucinate)
    const _maxBy = (arr, fn) => arr.reduce((best, r) => fn(r) > fn(best) ? r : best, arr[0]);
    const _minBy = (arr, fn) => arr.reduce((best, r) => fn(r) < fn(best) ? r : best, arr[0]);
    const _monthRate = r => (r.sale > 0) ? r.errors / r.sale * 100 : null;
    let quickStats = '';
    if (activeMonthsForStats.length) {
      const topSale   = _maxBy(activeMonthsForStats, r => r.sale || 0);
      const topErrors = _maxBy(activeMonthsForStats, r => r.errors || 0);
      const withSale  = activeMonthsForStats.filter(r => r.sale > 0);
      const topRate   = withSale.length ? _maxBy(withSale, r => _monthRate(r)) : null;
      const botRate   = withSale.length ? _minBy(withSale, r => _monthRate(r)) : null;
      quickStats = [
        `THỐNG KÊ NHANH (ĐÃ TÍNH SẴN — dùng trực tiếp, KHÔNG tự tính lại):`,
        `• Sale cao nhất: ${_fmtMonth(topSale.month)} — ${topSale.sale} units`,
        `• Lỗi nhiều nhất: ${_fmtMonth(topErrors.month)} — ${topErrors.errors} lỗi`,
        topRate ? `• TLL% cao nhất: ${_fmtMonth(topRate.month)} — ${_monthRate(topRate).toFixed(2)}%` : '',
        botRate ? `• TLL% thấp nhất: ${_fmtMonth(botRate.month)} — ${_monthRate(botRate).toFixed(2)}%` : '',
      ].filter(Boolean).join('\n');
    }

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
        dash.topByCategory?.length  ? `\nNHÓM LỖI = field "category" (dùng field="category" khi filter_field): ${fmtGroup(dash.topByCategory)}`  : '',
        dash.topByAccessory?.length ? `LINH KIỆN LỖI = field "err_accessory": ${fmtGroup(dash.topByAccessory)}` : '',
        dash.topByCause?.length     ? `NGUYÊN NHÂN = field "cause": ${fmtGroup(dash.topByCause)}`       : '',
        (() => { const vals = window.AppState?.getAllFieldValues?.('Time_sudung') || []; return vals.length ? `MỐC THỜI GIAN SỬ DỤNG = field "Time_sudung": ${vals.join(', ')}` : ''; })(),
        '\n⚠️ filter_field: dùng đúng field. "Bơm/Nguồn/Lọc/Dây điện/Đường nước/Mạch điện" là NHÓM LỖI → field="category". Tên linh kiện cụ thể → field="err_accessory". "dưới 1 tháng/từ X tháng/từ X năm" → field="Time_sudung". Hệ thống tự sửa nếu sai, nhưng hãy chọn đúng.',
        'Lưu ý: Dữ liệu trên là snapshot KHI BUILD system message. Gọi read_dashboard_groups để lấy số liệu MỚI NHẤT sau filter.',
        'filter_month/filter_product sẽ cập nhật slicer dashboard. sum_rate không dùng được ở đây.',
      ].filter(Boolean).join('\n');
      return SYSTEM_INSTRUCTION + '\n\n=== THỜI GIAN THỰC ===\n' + _timeCtx
        + '\n\n=== DỮ LIỆU DASHBOARD ===\n' + dashLines
        + '\n\n⚠️ OUTPUT: Chỉ trả về 1 JSON object thuần túy. Không markdown, không code block, không text nào khác.';
    }

    const tabLabel = { rate: 'Tỷ lệ lỗi (TLL)', data: 'Dữ liệu chi tiết', pivot: 'Phân tích Pivot' };
    const stateLines = [
      `Dataset:${s.activeDataset || 'spm1'} Tab hiện tại:${tabLabel[s.activeSubTab] || s.activeSubTab || 'rate'} Records:${s.recordCount || 0}`,
      filterParts.length ? `Filter:${filterParts.join('; ')}` : 'Filter: không có',
      quickStats        ? `\n${quickStats}` : '',
      errorRankLines    ? `\nTOP SẢN PHẨM LỖI NHIỀU NHẤT [snapshot trước khi lọc — nếu user hỏi theo năm/tháng cụ thể hãy dùng read_top_products sau filter_month thay vì quote đây]:\n${errorRankLines}` : '',
      productLines      ? `\nBẢNG SẢN PHẨM THEO TLL% [snapshot trước khi lọc] (xếp theo ${s.tableOrder === 'asc' ? 'TLL% thấp nhất' : 'TLL% cao nhất'}):\n${productLines}` : '',
      monthLines        ? `\nBẢNG THÁNG (6 tháng gần nhất):\n${monthLines}` : '',
    ].filter(Boolean).join('\n');

    return SYSTEM_INSTRUCTION + '\n\n=== THỜI GIAN THỰC ===\n' + _timeCtx
      + '\n\n=== DỮ LIỆU DASHBOARD ===\n' + stateLines
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
      description: 'Đọc xếp hạng nhóm lỗi/linh kiện/nguyên nhân/model từ Dashboard tab SAU KHI filter. by=category: nhóm lỗi; by=accessory: linh kiện lỗi; by=cause: nguyên nhân lỗi; by=product: model/SP nhiều lỗi nhất.',
      parameters: { type: 'object', properties: {
        by:    { type: 'string', enum: ['category', 'accessory', 'cause', 'product'], description: 'Loại nhóm cần đọc. by=product để xem model nào nhiều lỗi nhất.' },
        limit: { type: 'number', description: 'Số nhóm hiển thị (mặc định 10)' },
      }, required: ['by'] } },
    { name: 'filter_field',
      description: 'Lọc dashboard theo giá trị cụ thể của 1 field. Dùng khi user hỏi "lỗi X thuộc model nào". Hệ thống tự động tìm field đúng nếu AI chọn sai. field="category" cho nhóm lỗi rộng (Bơm, Nguồn, Lọc, Dây điện, Đường nước...), field="err_accessory" cho tên linh kiện cụ thể, field="cause" cho nguyên nhân.',
      parameters: { type: 'object', properties: {
        field: { type: 'string', enum: ['category', 'err_accessory', 'cause', 'region', 'err_classify'],
          description: 'category=nhóm lỗi rộng (Bơm/Nguồn/Lọc/Dây điện...) | err_accessory=tên linh kiện cụ thể | cause=nguyên nhân (người dùng/thiết kế...)' },
        value: { type: 'string', description: 'Giá trị cần lọc, VD: "Bơm", "Nguồn", "Lỗi lọc". Dùng đúng tên từ dữ liệu dashboard.' },
      }, required: ['field', 'value'] } },
    { name: 'read_saleout_table',
      description: 'Đọc dữ liệu Sale Out thực (sale + lỗi + TLL%) theo năm hoặc dải tháng. LUÔN dùng tool này khi hỏi về dữ liệu saleout, tổng bán ra. KHÔNG tự tính.',
      parameters: { type: 'object', properties: {
        year:   { type: 'number', description: 'Năm cần đọc, VD: 2025, 2026. Để trống nếu dùng months.' },
        months: { type: 'array', items: { type: 'string' }, description: 'Dải tháng cụ thể, VD: ["Y2501","Y2502"]. Dùng thay year nếu cần tháng cụ thể.' },
      } } },
  ];

  const SYSTEM_INSTRUCTION = `Bạn là trợ lý AI điều khiển CRM Dashboard phân tích lỗi sản phẩm Karofi.
LUÔN trả lời bằng JSON hợp lệ: {"actions":[...],"reply":"..."}

═══ BẢNG CHỌN TAB (action ĐẦU TIÊN) ════════════════════════════
switch_sub_tab tab="rate"      → tỷ lệ lỗi, TLL%, xu hướng, saleout
switch_sub_tab tab="data"      → tổng lỗi, bao nhiêu lỗi, đếm lỗi
switch_sub_tab tab="dashboard" → nhóm lỗi, LINH KIỆN lỗi, nguyên nhân, biểu đồ

═══ PHÂN BIỆT BẮT BUỘC ════════════════════════════════════════
"tỷ lệ lỗi / TLL% / lỗi %"          → sum_rate
"bao nhiêu lỗi / tổng lỗi / đếm lỗi" → sum_errors  ← KHÔNG dùng sum_rate

═══ read_dashboard_groups — CHỌN by ĐÚNG ══════════════════════
by="accessory" ← HỎI VỀ LINH KIỆN: "linh kiện / phụ kiện / bộ phận / accessory"
by="category"  ← HỎI VỀ NHÓM LỖI: "nhóm lỗi / loại lỗi / Bơm/Nguồn/Lọc"
by="cause"     ← HỎI VỀ NGUYÊN NHÂN: "nguyên nhân / lý do / cause"
by="product"   ← HỎI VỀ MODEL: "model nào / sản phẩm nào / máy nào"
⚠️ LUÔN gọi clear_filters trước read_dashboard_groups

═══ filter_field — CHỌN field ĐÚNG ════════════════════════════
field="category"     → "Bơm", "Nguồn", "Lọc", "Dây điện", "Đường nước", "Mạch điện"... (nhóm rộng)
field="err_accessory"→ tên linh kiện vật lý cụ thể
field="cause"        → "khách quan sử dụng", "lỗi thiết kế", "lỗi sản xuất"...
field="Time_sudung"  → mốc thời gian sử dụng: "dưới 1 tháng", "từ 2-3 tháng", "từ 3-6 tháng", "từ 6-12 tháng", "từ 1-2 năm"...
                    Thứ tự các mốc tăng dần: dưới 1 tháng → từ 2-3 tháng → từ 3-6 tháng → từ 6-12 tháng → từ 1-2 năm
                    QUY TẮC RANGE: "dưới X" = NHỎ HƠN HOẶC BẰNG X (≤ X, không phải < X)
                    → "từ 6-12 tháng" kết thúc tại 12 tháng = 1 năm → nằm trong "dưới 1 năm" ✅
                    → "từ 1-2 năm" kết thúc tại 2 năm → nằm trong "dưới 2 năm" ✅
                    Khi user hỏi KHOẢNG → value là MẢNG TẤT CẢ mốc có giá trị cuối ≤ ngưỡng:
                    "dưới 3 tháng"       → ["dưới 1 tháng","từ 2-3 tháng"]
                    "dưới 6 tháng"       → ["dưới 1 tháng","từ 2-3 tháng","từ 3-6 tháng"]
                    "dưới 1 năm/12 tháng"→ ["dưới 1 tháng","từ 2-3 tháng","từ 3-6 tháng","từ 6-12 tháng"]  ← bao gồm "từ 6-12 tháng"!
                    "dưới 2 năm/24 tháng"→ ["dưới 1 tháng","từ 2-3 tháng","từ 3-6 tháng","từ 6-12 tháng","từ 1-2 năm"]  ← tất cả 5 mốc!
                    "trên 6 tháng"       → ["từ 6-12 tháng","từ 1-2 năm"]
                    "từ 3-12 tháng"      → ["từ 3-6 tháng","từ 6-12 tháng"]

═══ ĐỊNH DẠNG THÁNG ════════════════════════════════════════════
Format: Y + 2 chữ NĂM + 2 chữ THÁNG
"07/2026"→Y2607 | "07/2025"→Y2506 | "năm 2025"→"2025" | "năm 2026"→"2026"
Q1=01-03, Q2=04-06, Q3=07-09, Q4=10-12

═══ ACTIONS ════════════════════════════════════════════════════
{"name":"switch_sub_tab","args":{"tab":"rate|data|dashboard"}}
{"name":"switch_main_tab","args":{"tab":"spm1|spm2"}}   ← CHỈ khi user nói rõ SPM1/SPM2
{"name":"clear_filters","args":{}}
{"name":"filter_month","args":{"month":"Y2507"}}        ← hoặc "Y2501,Y2502,..." hoặc "2025"
{"name":"filter_product","args":{"query":"tên SP"}}
{"name":"filter_field","args":{"field":"category","value":"Bơm"}}
{"name":"filter_field","args":{"field":"Time_sudung","value":["dưới 1 tháng","từ 2-3 tháng"]}}  ← khi lọc KHOẢNG
{"name":"sum_errors","args":{}}
{"name":"sum_rate","args":{}}
{"name":"read_top_products","args":{"by":"errors|rate|sale","limit":10}}
{"name":"read_dashboard_groups","args":{"by":"category|accessory|cause|product","limit":10}}
{"name":"read_saleout_table","args":{"year":2025}}
{"name":"analyze_trend","args":{"months":["Y2603","Y2604"]}}

═══ RULES QUAN TRỌNG ═══════════════════════════════════════════
1. KHÔNG tự bịa số liệu — PHẢI gọi tool để lấy số thực. KHÔNG mô tả các bước.
2. Mỗi câu hỏi ĐỘC LẬP — clear_filters trước filter mới.
3. Hỏi saleout/bán ra → LUÔN read_saleout_table, KHÔNG tự tính.
4. TOP SẢN PHẨM trong context = snapshot chưa lọc, KHÔNG dùng khi user hỏi theo năm/tháng.
5. "tháng này" = tháng hiện tại (xem THỜI GIAN THỰC trong context). "năm nay" = 2026.
6. LUÔN trả lời bằng JSON với actions. KHÔNG trả lời bằng văn xuôi mô tả bước.

═══ VÍ DỤ CHUẨN (làm theo đúng thứ tự này) ════════════════════
"tỷ lệ lỗi tháng 6/2026"
→ switch_sub_tab(rate) + clear_filters + filter_month(Y2606) + sum_rate

"tổng lỗi / bao nhiêu lỗi tháng 6/2026"
→ switch_sub_tab(data) + clear_filters + filter_month(Y2606) + sum_errors

"năm 2025 có bao nhiêu lỗi / tổng lỗi năm 2025"
→ switch_sub_tab(data) + clear_filters + filter_month("2025") + sum_errors

"tổng lỗi tháng này / tháng hiện tại bao nhiêu lỗi"
→ switch_sub_tab(data) + clear_filters + filter_month(tháng-này-từ-THỜI-GIAN-THỰC) + sum_errors

"nhóm lỗi / loại lỗi nhiều nhất"
→ switch_sub_tab(dashboard) + clear_filters + read_dashboard_groups(by=category)

"LINH KIỆN lỗi nhiều nhất / linh kiện nào lỗi nhiều / phụ kiện lỗi"
→ switch_sub_tab(dashboard) + clear_filters + read_dashboard_groups(by=accessory)  ← by=ACCESSORY

"nguyên nhân lỗi nhiều nhất"
→ switch_sub_tab(dashboard) + clear_filters + read_dashboard_groups(by=cause)

"năm 2025 nhóm lỗi / linh kiện nào nhiều nhất"
→ switch_sub_tab(dashboard) + clear_filters + filter_month("2025") + read_dashboard_groups(by=category|accessory)

"S88 tỷ lệ lỗi năm 2025"
→ switch_sub_tab(rate) + clear_filters + filter_product("S88") + filter_month("2025") + sum_rate

"S88 bao nhiêu lỗi năm 2025"
→ switch_sub_tab(data) + clear_filters + filter_product("S88") + filter_month("2025") + sum_errors

"chi tiết lỗi / lỗi gì nhiều ở S88"
→ switch_sub_tab(dashboard) + clear_filters + filter_product("S88") + read_dashboard_groups(by=category)

"lỗi Bơm thuộc model nào"
→ switch_sub_tab(dashboard) + clear_filters + filter_field(category,"Bơm") + read_dashboard_groups(by=product)

"số lỗi dưới 1 tháng / lỗi bơm dưới 1 tháng sử dụng"
→ switch_sub_tab(dashboard) + clear_filters + filter_field(Time_sudung,"dưới 1 tháng") + read_dashboard_groups(by=category)

"từ 1-2 năm sử dụng lỗi gì nhiều / mốc 6-12 tháng"
→ switch_sub_tab(dashboard) + clear_filters + filter_field(Time_sudung,"từ 1-2 năm") + read_dashboard_groups(by=category)

"lỗi dưới 6 tháng sử dụng / trong vòng nửa năm đầu"
→ switch_sub_tab(dashboard) + clear_filters + filter_field(Time_sudung,["dưới 1 tháng","từ 2-3 tháng","từ 3-6 tháng"]) + read_dashboard_groups(by=category)

"lỗi trên 6 tháng / từ nửa năm trở lên / dài hạn"
→ switch_sub_tab(dashboard) + clear_filters + filter_field(Time_sudung,["từ 6-12 tháng","từ 1-2 năm"]) + read_dashboard_groups(by=category)

"lỗi dưới 1 năm sử dụng / trong vòng 12 tháng đầu"
→ switch_sub_tab(dashboard) + clear_filters + filter_field(Time_sudung,["dưới 1 tháng","từ 2-3 tháng","từ 3-6 tháng","từ 6-12 tháng"]) + read_dashboard_groups(by=category)

"lỗi dưới 2 năm / trong vòng 2 năm sử dụng / tất cả trừ không xác định"
→ switch_sub_tab(dashboard) + clear_filters + filter_field(Time_sudung,["dưới 1 tháng","từ 2-3 tháng","từ 3-6 tháng","từ 6-12 tháng","từ 1-2 năm"]) + read_dashboard_groups(by=category)

"model nào TLL% tệ nhất năm 2025"
→ switch_sub_tab(rate) + clear_filters + filter_month("2025") + read_top_products(by=rate,limit=10)

"model nào lỗi nhiều nhất năm 2025"
→ switch_sub_tab(rate) + clear_filters + filter_month("2025") + read_top_products(by=errors,limit=10)

"xu hướng TLL% / diễn biến TLL% 3 tháng gần nhất"
→ switch_sub_tab(rate) + clear_filters + filter_month(3 tháng gần) + analyze_trend

"từ 05/2025-04/2026 sản phẩm nào TLL% cao nhất / diễn biến lỗi từ X đến Y"
→ switch_sub_tab(rate) + clear_filters + filter_month(range) + read_top_products(by=rate,limit=10) + analyze_trend

"dữ liệu saleout năm 2025"
→ switch_sub_tab(rate) + read_saleout_table(year=2025)

"hi / xin chào"
→ {"actions":[],"reply":"Xin chào! Tôi có thể lọc, phân tích xu hướng, hoặc trả lời câu hỏi về số liệu."}

Năm không hợp lệ (1015, 3000...) → KHÔNG gọi tools, reply giải thích.`;

  // ── Model rotation — Groq trước, fallback Gemini khi exhausted ──
  // Groq (09/2026): llama/qwen3-32b/compound đã bị loại bỏ. Các model còn lại đều 30 RPM, 1K RPD, 8K TPM, 200K TPD
  const GROQ_MODELS = [
    'openai/gpt-oss-120b',   // #1: mạnh nhất, reasoning model
    'qwen/qwen3.8-27b',      // #2: tiếng Việt tốt
    'openai/gpt-oss-20b',    // #3: nhẹ, fallback
  ];
  // Tham số riêng cho reasoning model — giảm reasoning để tiết kiệm token (8K TPM)
  const GROQ_MODEL_PARAMS = {
    'openai/gpt-oss-120b': { reasoning_effort: 'low' },
    'openai/gpt-oss-20b':  { reasoning_effort: 'low' },
    'qwen/qwen3.8-27b':    { reasoning_format: 'hidden' },
  };
  const GEMINI_MODELS = [
    'gemini-2.5-flash',       // #1: chính, 20 RPD (free), 1K RPM
    'gemini-2.5-flash-lite',  // #2: fallback nhanh, 20 RPD (free)
    'gemini-2.0-flash-001',   // #3: stable alias, RPD cao hơn
    'gemini-2.0-flash',       // #4: fallback nếu alias trên lỗi
  ];
  const _skipModels    = new Map(); // model → timestamp hết hạn skip (tạm thời, không vĩnh viễn)
  const _skipModelsPerm= new Set(); // models bị tắt hẳn (decommissioned/hết TPD ngày)
  const _403counts     = new Map(); // đếm 403 liên tiếp mỗi model
  const _noExtraParams = new Set(); // models không hỗ trợ GROQ_MODEL_PARAMS

  const SKIP_TEMP_MS   = 5 * 60 * 1000; // 403 tạm thời → skip 5 phút rồi thử lại

  function _isSkipped(m) {
    if (_skipModelsPerm.has(m)) return true;
    const until = _skipModels.get(m);
    if (!until) return false;
    if (Date.now() < until) return true;
    _skipModels.delete(m); // hết thời gian chờ → unblock
    _403counts.delete(m);
    return false;
  }

  function _resetTempSkips() {
    // Xóa tất cả skip tạm thời (dùng khi user thử lại sau báo lỗi)
    _skipModels.clear();
    _403counts.clear();
  }

  function _shouldSkipModel(status, body) {
    if (status === 429) return body.includes('per day') || body.includes('TPD')
      || body.includes('RESOURCE_EXHAUSTED') || body.includes('quota');
    // 413 có 2 nghĩa: "per minute" exceeded → retry; còn lại → request quá lớn cho model này → switch
    if (status === 413) return !body.includes('per minute');
    // 404 = model đã bị xoá / không có quyền truy cập → chuyển model khác
    if (status === 404) return true;
    if (body.includes('model_not_found') || body.includes('does not exist') || body.includes('model_decommissioned')) return true;
    if (status === 400) return body.includes('decommissioned') || body.includes('no longer supported')
      || body.includes('response_format') || body.includes('not supported');
    return false;
  }

  // ── Groq API — JSON mode, model rotation + exponential backoff ───────────
  async function _callGroq(userText, onActionStep, onDisambiguate) {
    _disambiguateCallback = onDisambiguate || null;
    // Ưu tiên: key trực tiếp (browser→Groq, không qua worker, tránh IP block)
    // Fallback: worker URL (nếu không có key trực tiếp)
    const key = _groqKeyDirect || APP_CONFIG.chatbot?.groqApiKey;
    const hasWorker = !key && APP_CONFIG.chatbot?.groqWorkerUrl && !APP_CONFIG.chatbot.groqWorkerUrl.includes('YOUR-WORKER');
    if (!key && !hasWorker) return null;

    const messages = [
      { role: 'system', content: _buildSystemMessage() },
      { role: 'user', content: userText },
    ];

    const RETRY_DELAYS = [4000, 12000, 35000]; // backoff cho TPM (per-minute)
    let data;

    const _nextAvailableModel = () => GROQ_MODELS.find(m => !_isSkipped(m)) || null;

    // Vòng ngoài: thử từng model theo thứ tự ưu tiên
    while (true) {
      const model = _nextAvailableModel();
      if (!model) throw new Error('ALL_MODELS_EXHAUSTED');

      // Vòng trong: retry TPM cho model hiện tại
      let switched = false;
      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        const workerUrl = APP_CONFIG.chatbot?.groqWorkerUrl;
        // Dùng proxy CHỈ KHI không có key trực tiếp — nếu có key (từ NocoDB) thì gọi Groq thẳng
        const useProxy = !key && workerUrl && !workerUrl.includes('YOUR-WORKER');
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
            // Reasoning model tính cả token suy luận vào max_tokens → cần dư hơn 420
            max_tokens: 1200,
            response_format: { type: 'json_object' },
            ...(_noExtraParams.has(model) ? {} : (GROQ_MODEL_PARAMS[model] || {})),
          }),
        });

        if (!res.ok) {
          const errBody = await res.text();
          // Model không nhận tham số reasoning → bỏ tham số và gửi lại
          if (res.status === 400 && /reasoning_(effort|format)/.test(errBody) && !_noExtraParams.has(model)) {
            _noExtraParams.add(model);
            attempt--;
            continue;
          }
          if (_shouldSkipModel(res.status, errBody)) {
            // Model không dùng được (hết TPD hoặc bị tắt) → skip vĩnh viễn trong session
            _skipModelsPerm.add(model);
            const next = _nextAvailableModel();
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
            _skipModels.set(model, Date.now() + SKIP_TEMP_MS);
            const next = _nextAvailableModel();
            onActionStep?.({ tool: '_retry', input: { note: `${model} lỗi JSON → chuyển sang ${next || 'hết model'}` }, status: next ? 'running' : 'error' });
            if (next) onActionStep?.({ tool: '_retry', input: {}, status: 'done' });
            switched = true;
            break;
          }
          if (res.status === 403 || res.status === 401) {
            // Phân biệt: 403 do key hỏng vs 403 do Groq rate-limit (thường báo nhầm thay vì 429)
            const isRateLimit = errBody.includes('rate_limit') || errBody.includes('tokens')
              || errBody.includes('per_minute') || errBody.includes('quota')
              || errBody.includes('limit_exceeded') || errBody.includes('try again');
            const isKeyError  = errBody.includes('invalid_api_key') || errBody.includes('Invalid API Key')
              || errBody.includes('authentication') || errBody.includes('Unauthorized');

            if (isRateLimit || (!isKeyError && res.status === 403)) {
              // Rate limit giả dạng 403 → retry với backoff như 429
              if (attempt >= RETRY_DELAYS.length) { switched = true; break; }
              const retryMatch = errBody.match(/try again in (\d+\.?\d*)s/i);
              const wait = retryMatch ? Math.ceil(parseFloat(retryMatch[1]) * 1000) + 1000 : RETRY_DELAYS[attempt];
              onActionStep?.({ tool: '_retry', input: { attempt: attempt + 1, wait }, status: 'running' });
              await new Promise(r => setTimeout(r, wait));
              onActionStep?.({ tool: '_retry', input: {}, status: 'done' });
              continue;
            }
            // Key thực sự hỏng → skip 5 phút rồi thử lại (không skip vĩnh viễn)
            _skipModels.set(model, Date.now() + SKIP_TEMP_MS);
            const next = _nextAvailableModel();
            onActionStep?.({ tool: '_retry', input: { note: `${model} → key lỗi, thử ${next || 'lại sau'}` }, status: next ? 'running' : 'error' });
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
    // Bỏ phần suy luận <think>...</think> nếu model trả lẫn vào content
    const raw = (data?.choices?.[0]?.message?.content || '{}').replace(/<think>[\s\S]*?<\/think>/g, '').trim() || '{}';
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch (_) {
      const m = raw.match(/\{[\s\S]*\}/);
      try { parsed = JSON.parse(m?.[0] || '{}'); } catch (_) {}
    }
    return _processParsedAI(parsed, userText, onActionStep);
  }

  // ── Shared AI response processor (Groq + Gemini dùng chung) ─────────────
  async function _processParsedAI(parsed, userText, onActionStep) {
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
    const replyRaw   = parsed.reply || '';
    const reply      = (typeof replyRaw === 'string' ? replyRaw : JSON.stringify(replyRaw)).trim();

    // Lưu user text để executor có thể tham chiếu (auto-correct args)
    _lastUserText = userText || '';

    // Chặn action bị hallucinate dựa vào nội dung câu hỏi của user
    const lower = _lastUserText.toLowerCase();
    const allowSwitch  = /\bspm1\b|\bspm2\b|chuyển dataset|thiết kế mới|tất cả lỗi linh kiện/.test(lower);
    const allowTopN    = /\btop\s*\d|\bhiển thị\s+\d/.test(lower);
    const allowSort    = /sắp xếp|giảm dần|tăng dần/.test(lower);
    // filter_product: chỉ cho phép khi user đề cập đến sản phẩm/SP/model cụ thể
    const allowProduct = /lọc\s*(sp|sản phẩm|model)|sản phẩm|tên sp|\bsp\b|\bmodel\b|\bmáy\b|kae|kad|kaq|kah|platinum|livotec|wpk|\bs\d{2,}\b|\b[a-zđ]{1,4}\d+[a-z]*\b|\b\d+[a-z]+\b/.test(lower);
    const actions = rawActions.filter(a => {
      if (a.name === 'switch_main_tab' && !allowSwitch)  return false;
      // switch_sub_tab: cho phép AI tự động chuyển tab theo ngữ cảnh câu hỏi
      if (a.name === 'set_top_n'       && !allowTopN)    return false;
      if (a.name === 'set_sort_order'  && !allowSort)    return false;
      if (a.name === 'filter_product'  && !allowProduct) return false;
      return true;
    });

    // ── Keyword fallback cho AI 8B hay fail ─────────────────────────────────
    // Khi AI không tạo được read tool nào (actions rỗng hoặc chỉ có switch/clear),
    // tự động inject đúng tool dựa vào keywords trong câu hỏi user
    const hasReadTool = actions.some(a =>
      ['read_dashboard_groups','read_top_products','sum_errors','sum_rate',
       'analyze_trend','read_saleout_table'].includes(a.name));

    if (!hasReadTool) {
      // Pattern 1: hỏi về linh kiện/nhóm lỗi/nguyên nhân → dashboard
      const isDashQ =
        /linh kiện|linh_kien|accessory|phụ kiện|phụ tùng|bộ phận/.test(lower) ||
        /nguyên nhân|cause|lý do lỗi/.test(lower) ||
        /nhóm lỗi|loại lỗi|lỗi nào.*nhiều|nhiều.*nhất.*(lỗi|nhóm)|phân loại lỗi/.test(lower) ||
        /chi tiết lỗi|biểu đồ lỗi/.test(lower);

      if (isDashQ) {
        const byVal =
          /linh kiện|linh_kien|accessory|phụ kiện|phụ tùng|bộ phận/.test(lower) ? 'accessory' :
          /nguyên nhân|cause|lý do lỗi/.test(lower) ? 'cause' : 'category';
        if (!actions.some(a => a.name === 'switch_sub_tab'))
          actions.unshift({ name: 'switch_sub_tab', args: { tab: 'dashboard' } });
        if (!actions.some(a => a.name === 'clear_filters'))
          actions.push({ name: 'clear_filters', args: {} });
        actions.push({ name: 'read_dashboard_groups', args: { by: byVal, limit: 10 } });

      // Pattern 2: hỏi tổng lỗi/bao nhiêu lỗi → sum_errors
      } else if (/bao nhiêu lỗi|tổng lỗi|đếm lỗi|có bao nhiêu lỗi|số lỗi/.test(lower)) {
        const now = new Date();
        // Detect "tháng này/hiện tại" → filter tháng hiện tại
        if (/tháng này|tháng hiện tại|tháng nay/.test(lower)) {
          const mCode = `Y${String(now.getFullYear()).slice(-2)}${String(now.getMonth()+1).padStart(2,'0')}`;
          if (!actions.some(a => a.name === 'switch_sub_tab'))
            actions.unshift({ name: 'switch_sub_tab', args: { tab: 'data' } });
          actions.push({ name: 'clear_filters', args: {} });
          actions.push({ name: 'filter_month', args: { month: mCode } });
        } else if (!actions.some(a => a.name === 'switch_sub_tab')) {
          actions.unshift({ name: 'switch_sub_tab', args: { tab: 'data' } });
        }
        actions.push({ name: 'sum_errors', args: {} });

      // Pattern 3: hỏi tỷ lệ lỗi/TLL% → sum_rate
      } else if (/tỷ lệ lỗi|tll%|tll ?%|lỗi bao nhiêu %/.test(lower)) {
        if (!actions.some(a => a.name === 'switch_sub_tab'))
          actions.unshift({ name: 'switch_sub_tab', args: { tab: 'rate' } });
        actions.push({ name: 'sum_rate', args: {} });
      }
    }

    // Auto-inject clear_filters khi AI quên:
    // 1) Trước filter_month/filter_product (filter mới → cần xoá filter cũ)
    // 2) Trước read_dashboard_groups khi không có filter action nào (đọc toàn bộ → cần xoá filter cũ)
    const hasNewFilter     = actions.some(a => a.name === 'filter_month' || a.name === 'filter_product' || a.name === 'filter_field');
    const hasExplicitClear = actions.some(a => a.name === 'clear_filters');
    const hasDashRead      = actions.some(a => a.name === 'read_dashboard_groups');
    if (!hasExplicitClear && (hasNewFilter || (hasDashRead && !hasNewFilter))) {
      actions.unshift({ name: 'clear_filters', args: {} });
    }

    // Đảm bảo clear_filters luôn đứng TRƯỚC mọi filter_* (AI đôi khi đặt sai thứ tự khi user nói "tất cả")
    const clearIdx   = actions.findIndex(a => a.name === 'clear_filters');
    const firstFilterIdx = actions.findIndex(a => a.name === 'filter_month' || a.name === 'filter_product');
    if (clearIdx !== -1 && firstFilterIdx !== -1 && clearIdx > firstFilterIdx) {
      const [clearAction] = actions.splice(clearIdx, 1);
      actions.splice(firstFilterIdx, 0, clearAction);
    }

    // Auto-add analyze_trend khi user hỏi TLL% theo dải tháng nhưng AI quên phân tích xu hướng
    // Điều kiện: có filter_month (≥ 2 tháng hoặc cả năm) + có sum_rate/read_top_products(rate) + không có analyze_trend
    const hasMonthFilter  = actions.some(a => a.name === 'filter_month');
    const hasRateRead     = actions.some(a => a.name === 'sum_rate' || (a.name === 'read_top_products' && (a.args?.by === 'rate' || a.args?.by === 'errors')));
    const hasTrendAlready = actions.some(a => a.name === 'analyze_trend');
    const isTrendQ = /diễn biến|xu hướng|theo tháng|qua các tháng|từ tháng|từ \d{2}\/\d{4}|từ \d{4}|đến \d{2}\/\d{4}/.test(lower);
    if (hasMonthFilter && hasRateRead && !hasTrendAlready && isTrendQ) {
      actions.push({ name: 'analyze_trend', args: {} });
    }

    // Nếu filter_field có trong actions → đảm bảo tab dashboard và có read tool
    const hasFilterField = actions.some(a => a.name === 'filter_field');
    if (hasFilterField) {
      for (const a of actions) {
        if (a.name === 'switch_sub_tab' && a.args?.tab !== 'dashboard') {
          a.args.tab = 'dashboard';
        }
      }
      if (!actions.some(a => a.name === 'switch_sub_tab')) {
        actions.unshift({ name: 'switch_sub_tab', args: { tab: 'dashboard' } });
      }
      if (!actions.some(a => a.name === 'read_dashboard_groups')) {
        const byVal = /model nào|sản phẩm nào|máy nào|sp nào/.test(lower) ? 'product' : 'product';
        actions.push({ name: 'read_dashboard_groups', args: { by: byVal, limit: 10 } });
      }
    }

    // Sắp xếp thứ tự chuẩn: switch_tab → clear → filter → other → read
    // switch_sub_tab PHẢI chạy trước filter_product để filter đúng ngữ cảnh (dashboard vs saleout)
    const READ_TOOLS  = new Set(['read_saleout_table','read_top_products','read_dashboard_groups','sum_errors','sum_rate','analyze_trend']);
    const TAB_ACTIONS = new Set(['switch_main_tab','switch_sub_tab']);
    const actTab    = actions.filter(a =>  TAB_ACTIONS.has(a.name));
    const actClear  = actions.filter(a =>  a.name === 'clear_filters');
    const actFilter = actions.filter(a =>  (a.name === 'filter_month' || a.name === 'filter_product'));
    const actRead   = actions.filter(a =>  READ_TOOLS.has(a.name));
    const actOther  = actions.filter(a => !TAB_ACTIONS.has(a.name) && a.name !== 'clear_filters'
                                       && a.name !== 'filter_month' && a.name !== 'filter_product'
                                       && !READ_TOOLS.has(a.name));
    actions.length = 0;
    actions.push(...actTab, ...actClear, ...actFilter, ...actOther, ...actRead);

    // Thực thi actions
    const toolResults = [];
    const readResults = []; // gom tất cả kết quả từ read-tools, không để tool sau xóa tool trước
    for (const action of actions) {
      const name = action.name;
      const args = action.args || {};
      onActionStep?.({ tool: name, input: args, status: 'running' });
      const exec   = EXECUTORS[name];
      const result = exec ? await exec(args) : `Action "${name}" không tồn tại`;
      onActionStep?.({ tool: name, input: args, status: 'done', result });
      toolResults.push(result);
      if (['sum_errors','sum_rate','analyze_trend','read_top_products','read_dashboard_groups','read_saleout_table'].includes(name)) {
        if (result) readResults.push(result);
      }
    }

    // Ghép tất cả kết quả read-tools (tránh tool cuối xóa dữ liệu của tool trước)
    const sumResult = readResults.length ? readResults.join('\n\n') : null;
    const actionsRan = toolResults.length > 0;
    // reply = câu trả lời trọng tâm của AI; sumResult = dữ liệu chi tiết từ tool
    // Nếu cả hai đều có → hiện reply trước (trả lời đúng trọng tâm), sumResult sau (chi tiết)
    // Nếu chỉ có sumResult → hiện sumResult (AI không cần tóm tắt thêm)
    const text = (reply && sumResult) ? `${reply}\n\n${sumResult}`
      : sumResult || reply || toolResults.filter(Boolean).join('\n')
      || (actionsRan ? 'Đã thực hiện.' : 'Xin lỗi, tôi chưa hiểu yêu cầu này. Bạn có thể hỏi lại hoặc thử diễn đạt khác không?');
    return { text, toolResults };
  }

  // ── Gemini API — JSON mode, model rotation + retry ──────────────────────
  function _shouldSkipGemini(status, body) {
    if (status === 429) {
      // Hết quota ngày → skip vĩnh viễn; hết quota phút → retry
      return (body.includes('RESOURCE_EXHAUSTED') || body.includes('quota')) &&
        !body.includes('per minute') && !body.includes('minute');
    }
    if (status === 404) return true; // model không tồn tại
    if (status === 400) return body.includes('API_KEY_INVALID') || body.includes('not supported');
    return false;
  }

  async function _callGemini(userText, onActionStep, onDisambiguate) {
    _disambiguateCallback = onDisambiguate || null;
    const key = _geminiKeyDirect || APP_CONFIG.chatbot?.geminiApiKey;
    if (!key) return null;

    const systemMsg = _buildSystemMessage();
    const RETRY_DELAYS = [5000, 15000, 40000];
    let data;

    const _nextModel = () => GEMINI_MODELS.find(m => !_isSkipped(m)) || null;

    while (true) {
      const model = _nextModel();
      if (!model) throw new Error('ALL_MODELS_EXHAUSTED');

      let switched = false;
      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemMsg }] },
            contents: [{ role: 'user', parts: [{ text: userText }] }],
            generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 420 },
          }),
        });

        if (!res.ok) {
          const errBody = await res.text();
          if (_shouldSkipGemini(res.status, errBody)) {
            _skipModelsPerm.add(model);
            const next = _nextModel();
            onActionStep?.({ tool: '_retry', input: { note: `${model} không khả dụng → chuyển sang ${next || 'hết model'}` }, status: next ? 'running' : 'error' });
            if (next) onActionStep?.({ tool: '_retry', input: {}, status: 'done' });
            switched = true;
            break;
          }
          if (res.status === 429 || res.status === 503) {
            if (attempt >= RETRY_DELAYS.length) throw new Error(`Gemini API ${res.status}: ${errBody.slice(0, 300)}`);
            const retryMatch = errBody.match(/retryDelay[^"]*"(\d+)s"/) || errBody.match(/try again in (\d+\.?\d*)s/i);
            const wait = retryMatch ? Math.ceil(parseFloat(retryMatch[1]) * 1000) + 1000 : RETRY_DELAYS[attempt];
            onActionStep?.({ tool: '_retry', input: { attempt: attempt + 1, wait }, status: 'running' });
            await new Promise(r => setTimeout(r, wait));
            onActionStep?.({ tool: '_retry', input: {}, status: 'done' });
            continue;
          }
          if (res.status === 403 || res.status === 401) {
            _skipModels.set(model, Date.now() + SKIP_TEMP_MS);
            const next = _nextModel();
            onActionStep?.({ tool: '_retry', input: { note: `${model} → key lỗi, thử ${next || 'lại sau'}` }, status: next ? 'running' : 'error' });
            if (next) onActionStep?.({ tool: '_retry', input: {}, status: 'done' });
            switched = true;
            break;
          }
          throw new Error(`Gemini API ${res.status}: ${errBody.slice(0, 160)}`);
        }

        data = await res.json();
        break;
      }
      if (!switched) break;
    }

    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch (_) {
      const m = raw.match(/\{[\s\S]*\}/);
      try { parsed = JSON.parse(m?.[0] || '{}'); } catch (_) {}
    }
    return _processParsedAI(parsed, userText, onActionStep);
  }

  // ── Main sendMessage (Groq → Gemini fallback) ──
  async function sendMessage(userText, { onActionStep, onDisambiguate } = {}) {
    const hasGroq = !!(_groqKeyDirect || APP_CONFIG.chatbot?.groqApiKey ||
      (APP_CONFIG.chatbot?.groqWorkerUrl && !APP_CONFIG.chatbot.groqWorkerUrl.includes('YOUR-WORKER')));
    const hasGemini = !!(_geminiKeyDirect || APP_CONFIG.chatbot?.geminiApiKey);
    if (!hasGroq && !hasGemini) {
      return { source: 'none', message: 'Chưa cấu hình API key (Groq hoặc Gemini) trong appConfig.js.' };
    }
    try {
      let result = null;
      let provider = 'groq';

      // Ưu tiên Groq (nhanh hơn 3-5x)
      if (hasGroq) {
        try {
          result = await _callGroq(userText, onActionStep, onDisambiguate);
        } catch (groqErr) {
          if (groqErr.message !== 'ALL_MODELS_EXHAUSTED') throw groqErr;
          _resetTempSkips();
          if (hasGemini) {
            onActionStep?.({ tool: '_retry', input: { note: 'Groq hết quota → chuyển Gemini...' }, status: 'running' });
            onActionStep?.({ tool: '_retry', input: {}, status: 'done' });
          }
        }
      }

      // Fallback Gemini nếu Groq không có key hoặc đã exhausted
      if (!result && hasGemini) {
        provider = 'gemini';
        result = await _callGemini(userText, onActionStep, onDisambiguate);
      }

      if (!result) {
        return { source: 'error', message: 'Chưa cấu hình API key hợp lệ.' };
      }

      _history.push(
        { role: 'user',  parts: [{ text: userText }] },
        { role: 'model', parts: [{ text: result.text }] },
      );
      if (_history.length > 20) _history = _history.slice(-20);
      return { source: provider, message: result.text };
    } catch (err) {
      console.error('[ChatbotService]', err);
      if (err.message === 'ALL_MODELS_EXHAUSTED') {
        _resetTempSkips();
        return { source: 'error', message: 'AI đang bận tạm thời. Vui lòng thử lại sau vài giây.' };
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
      return { source: 'error', message: 'Hệ thống AI gặp sự cố tạm thời. Vui lòng thử lại hoặc diễn đạt câu hỏi theo cách khác.' };
    }
  }

  function clearHistory() { _history = []; }

  return { sendMessage, clearHistory, loadKey };
})();
