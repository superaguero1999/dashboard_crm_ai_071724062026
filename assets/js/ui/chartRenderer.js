const ChartRenderer = (() => {
  let _chart = null;
  let _chartType = 'bar';
  let _sortType = 'none';
  let _drillData = [];
  let _drillConfig = null;

  function setType(type) { _chartType = type; }
  function getType()     { return _chartType; }
  function setSort(type) { _sortType = type; }

  function setDrilldown(data, config) {
    _drillData = data || [];
    _drillConfig = config || null;
  }

  function sortChartData(chartData, sortType) {
    if (!sortType || sortType === 'none' || !chartData.labels.length) return chartData;
    const { labels, datasets } = chartData;
    const idx = labels.map((_, i) => i);
    if (sortType === 'value-desc' || sortType === 'value-asc') {
      const sums = idx.map(i => datasets.reduce((s, ds) => s + (Number(ds.data[i]) || 0), 0));
      idx.sort((a, b) => sortType === 'value-asc' ? sums[a] - sums[b] : sums[b] - sums[a]);
    } else if (sortType === 'label-asc') {
      idx.sort((a, b) => String(labels[a]).localeCompare(String(labels[b]), 'vi'));
    } else if (sortType === 'label-desc') {
      idx.sort((a, b) => String(labels[b]).localeCompare(String(labels[a]), 'vi'));
    }
    return {
      labels:   idx.map(i => labels[i]),
      datasets: datasets.map(ds => ({ ...ds, data: idx.map(i => ds.data[i]) })),
    };
  }

  // ─── Drilldown: lọc bản ghi raw khớp với ô được click ─────────────────────
  function _getMatchingRecords(rowKey, colKey) {
    if (!_drillConfig || !_drillData.length) return [];

    let filtered = _drillData;

    // Áp dụng filter của pivot
    for (const f of (_drillConfig.filters || [])) {
      filtered = filtered.filter(row => {
        const v = (row[f.field] || '').toString().trim();
        switch (f.op) {
          case 'eq':       return v === f.value;
          case 'neq':      return v !== f.value;
          case 'contains': return v.toLowerCase().includes(f.value.toLowerCase());
          default:         return true;
        }
      });
    }

    // Lọc theo row key
    if (rowKey != null && (_drillConfig.rows || []).length) {
      const parts = rowKey.split(' › ');
      filtered = filtered.filter(row =>
        _drillConfig.rows.every((field, i) => (row[field] || '—').toString() === parts[i])
      );
    }

    // Lọc theo col key (null với pie/doughnut → bỏ qua)
    if (colKey != null && (_drillConfig.cols || []).length) {
      const parts = colKey.split(' › ');
      filtered = filtered.filter(row =>
        _drillConfig.cols.every((field, i) => (row[field] || '—').toString() === parts[i])
      );
    }

    return filtered;
  }

  // ─── Hiển thị modal drilldown ──────────────────────────────────────────────
  function _showDrillModal(rowKey, colKey) {
    try {
    const modal    = document.getElementById('drilldown-modal');
    const titleEl  = document.getElementById('drilldown-title');
    const countEl  = document.getElementById('drilldown-count');
    const tableWrap = document.getElementById('drilldown-table-wrap');
    if (!modal) { console.warn('[DrillDown] modal element not found'); return; }

    const records = _getMatchingRecords(rowKey, colKey);

    // Tiêu đề
    const labelParts = [rowKey].concat(colKey != null ? [colKey] : []).filter(Boolean);
    titleEl.textContent = 'Chi tiết: ' + labelParts.join(' — ');
    countEl.textContent = `${records.length} bản ghi`;

    // Bảng dữ liệu
    const fields = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.fieldDefinitions) || [];
    if (!records.length) {
      tableWrap.innerHTML = '<p class="text-center text-gray-400 py-12 text-sm">Không có bản ghi nào khớp</p>';
    } else {
      const thead = `<thead class="sticky top-0 bg-blue-50 z-10"><tr>${
        fields.map(f =>
          `<th class="px-3 py-2 text-left text-xs font-semibold text-blue-700 whitespace-nowrap border-b border-blue-200">${f.label}</th>`
        ).join('')
      }</tr></thead>`;

      const tbody = `<tbody>${records.map((row, i) =>
        `<tr class="${i % 2 === 0 ? 'bg-white' : 'bg-gray-50'} hover:bg-blue-50 transition-colors">${
          fields.map(f => {
            const val = row[f.key] != null ? String(row[f.key]) : '';
            return `<td class="px-3 py-1.5 text-xs text-gray-700 border-b border-gray-100" style="min-width:80px;max-width:280px;white-space:normal;word-break:break-word">${val}</td>`;
          }).join('')
        }</tr>`
      ).join('')}</tbody>`;

      tableWrap.innerHTML = `<table class="min-w-full text-sm">${thead}${tbody}</table>`;
    }

    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    } catch (e) { console.error('[DrillDown] _showDrillModal error:', e); }
  }

  // ─── Đóng modal ───────────────────────────────────────────────────────────
  function _closeDrillModal() {
    const modal = document.getElementById('drilldown-modal');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = '';
  }

  // Khởi tạo event đóng modal (chỉ 1 lần)
  let _modalEventsReady = false;
  function _initModalEvents() {
    if (_modalEventsReady) return;
    _modalEventsReady = true;
    document.getElementById('drilldown-close')?.addEventListener('click', _closeDrillModal);
    document.getElementById('drilldown-backdrop')?.addEventListener('click', _closeDrillModal);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') _closeDrillModal(); });
  }

  // ─── Render chart ──────────────────────────────────────────────────────────
  function render(pivotResult, canvasId) {
    _initModalEvents();

    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    const resolvedType = _chartType === 'area' ? 'line' : _chartType;
    const chartData = sortChartData(PivotEngine.toChartData(pivotResult, _chartType), _sortType);

    // Show/hide no-data overlay without removing canvas
    let overlay = canvas.parentElement.querySelector('.chart-no-data');
    if (!chartData.labels.length) {
      if (_chart) { _chart.destroy(); _chart = null; }
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'chart-no-data absolute inset-0 flex items-center justify-center text-gray-400 text-sm';
        overlay.textContent = 'Chưa có dữ liệu để vẽ biểu đồ';
        canvas.parentElement.appendChild(overlay);
      }
      overlay.style.display = '';
      canvas.style.display = 'none';
      return;
    }
    if (overlay) overlay.style.display = 'none';
    canvas.style.display = '';

    if (_chart) _chart.destroy();

    const isPolar = ['pie', 'doughnut', 'radar'].includes(resolvedType);

    _chart = new Chart(ctx, {
      type: resolvedType,
      data: chartData,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: isPolar ? 4 : 20 } },
        onClick: (evt, elements, chart) => {
          try {
            // Nếu click trúng đúng element thì dùng luôn, không thì tìm nearest
            let active = elements && elements.length ? elements
              : (evt.native ? chart.getElementsAtEventForMode(evt.native, 'nearest', { intersect: false }, false) : []);
            if (!active || !active.length) return;
            const el = active[0];
            const rowKey = chartData.labels[el.index];
            const colKey = isPolar ? null : (chartData.datasets[el.datasetIndex]?.label ?? null);
            _showDrillModal(rowKey, colKey);
          } catch (e) {
            console.error('[DrillDown] onClick error:', e);
          }
        },
        onHover: (evt, elements) => {
          try {
            if (evt.native && evt.native.target) {
              evt.native.target.style.cursor = elements.length ? 'pointer' : 'default';
            }
          } catch (_) {}
        },
        plugins: {
          legend: { position: 'top', labels: { font: { size: 12 } } },
          tooltip: {
            callbacks: {
              label: ctx => {
                const val = ctx.parsed.y ?? ctx.parsed;
                return ` ${ctx.dataset.label}: ${typeof val === 'number' ? val.toLocaleString('vi-VN', { maximumFractionDigits: 2 }) : val}`;
              },
              afterBody: () => ['', 'Click để xem chi tiết bản ghi'],
            },
          },
          datalabels: {
            display: ctx => {
              const v = ctx.dataset.data[ctx.dataIndex];
              return typeof v === 'number' ? v > 0 : !!v;
            },
            anchor: isPolar ? 'center' : 'end',
            align:  isPolar ? 'center' : 'top',
            offset: 2,
            formatter: val => typeof val === 'number'
              ? val.toLocaleString('vi-VN', { maximumFractionDigits: 1 })
              : (val || ''),
            font: { size: 10, weight: '600' },
            color: isPolar ? '#fff' : '#374151',
          },
        },
        clip: false,
        scales: isPolar ? {} : {
          x: { grid: { display: false }, ticks: { font: { size: 11 } } },
          y: { beginAtZero: true, grace: '10%', ticks: { font: { size: 11 } } },
        },
        elements: {
          line: { tension: _chartType === 'area' ? 0.4 : 0.1, fill: _chartType === 'area' },
        },
      },
    });
  }

  function download(filename = 'chart.png') {
    if (!_chart) return;
    const link = document.createElement('a');
    link.download = filename;
    link.href = _chart.toBase64Image();
    link.click();
  }

  // Public: dùng bởi DashboardRenderer để kích hoạt drilldown với data riêng
  function drillFrom(rawData, config, rowKey, colKey) {
    _drillData   = rawData || [];
    _drillConfig = config  || null;
    _initModalEvents();
    _showDrillModal(rowKey, colKey);
  }

  return { render, setType, getType, setSort, sortChartData, download, setDrilldown, drillFrom };
})();
