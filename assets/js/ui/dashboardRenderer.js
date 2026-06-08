const DashboardRenderer = (() => {
  let _data = [];
  const _charts = {};
  let _slicerSearchQueries = {};

  function setData(data) { _data = data; }

  function _canvasId(name) {
    return 'dc_' + name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
  }

  function _loadOrder() {
    const views = DataService.loadPivotViews();
    const names = Object.keys(views);
    const saved = JSON.parse(localStorage.getItem('crm_dashboard_order') || '[]');
    return [...saved.filter(n => names.includes(n)), ...names.filter(n => !saved.includes(n))];
  }

  function _saveOrder(order) {
    localStorage.setItem('crm_dashboard_order', JSON.stringify(order));
  }

  function _destroyAll() {
    Object.keys(_charts).forEach(k => {
      try { _charts[k].destroy(); } catch (_) {}
      delete _charts[k];
    });
  }

  // ── Slicer Panel ──────────────────────────────────────────────────────────

  function _renderSlicerPanel() {
    const listEl = document.getElementById('slicer-list');
    if (!listEl) return;

    // Lưu scroll position và search query trước khi rebuild HTML
    const listScroll = listEl.scrollTop;
    const valScrolls = {};
    listEl.querySelectorAll('.slicer-card').forEach(card => {
      const valEl = card.querySelector('.overflow-y-auto');
      if (valEl) valScrolls[card.dataset.slicerId] = valEl.scrollTop;
    });
    listEl.querySelectorAll('.slicer-search').forEach(input => {
      _slicerSearchQueries[input.dataset.id] = input.value;
    });

    const slicers = SlicerService.getAll();
    const viewNames = Object.keys(DataService.loadPivotViews());

    if (!slicers.length) {
      listEl.innerHTML = `
        <p class="text-xs text-gray-400 italic px-2 py-3 text-center leading-relaxed">
          Chưa có slicer nào.<br>Nhấn <strong class="text-gray-500">+ Thêm</strong> để tạo.
        </p>`;
    } else {
      listEl.innerHTML = slicers.map(s => {
        const fieldDef = APP_CONFIG.fieldDefinitions.find(f => f.key === s.field);
        const label = fieldDef ? fieldDef.label : s.field;
        const uniqueVals = SlicerService.getUniqueValues(_data, s.field);
        const isAll = s.linkedCharts === 'all';
        const linked = Array.isArray(s.linkedCharts) ? s.linkedCharts : [];

        return `
          <div class="slicer-card border border-gray-200 rounded-lg mb-2 overflow-hidden text-xs" data-slicer-id="${s.id}">
            <div class="flex items-center justify-between px-2.5 py-1.5 bg-gray-50 border-b border-gray-100">
              <span class="font-semibold text-gray-700 truncate" title="${label}">${label}</span>
              ${AuthService.isEditor() ? `<button class="slicer-del text-gray-300 hover:text-red-500 ml-1 flex-shrink-0 transition-colors leading-none"
                      data-id="${s.id}" title="Xóa slicer">✕</button>` : ''}
            </div>
            <div class="px-2 pt-1.5">
              <input type="text" class="slicer-search w-full text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:border-blue-400 bg-white placeholder-gray-300"
                     data-id="${s.id}" placeholder="🔍 Tìm..."
                     value="${(_slicerSearchQueries[s.id] || '').replace(/"/g,'&quot;')}">
            </div>
            <div class="p-2 flex flex-col gap-2">
              <div class="flex flex-wrap gap-1 max-h-36 overflow-y-auto pr-0.5">
                ${uniqueVals.length === 0
                  ? `<span class="text-gray-300 italic">Không có dữ liệu</span>`
                  : uniqueVals.map(v => {
                      const isActive = s.selectedValues.length === 0 || s.selectedValues.includes(v);
                      const escaped = v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                      return `<button class="slicer-val px-1.5 py-0.5 rounded border transition-colors
                                ${isActive
                                  ? 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700'
                                  : 'bg-white text-gray-500 border-gray-200 hover:border-blue-400 hover:text-blue-600'}"
                                data-id="${s.id}" data-val="${escaped}">${v || '(trống)'}</button>`;
                    }).join('')
                }
              </div>
              ${s.selectedValues.length
                ? `<button class="slicer-clear text-blue-500 hover:text-blue-700 self-start transition-colors" data-id="${s.id}">✕ Bỏ lọc</button>`
                : ''
              }
              ${viewNames.length > 0 && AuthService.isEditor() ? `
              <div class="border-t border-gray-100 pt-1.5">
                <p class="text-gray-400 mb-1.5 font-medium">Áp dụng cho:</p>
                <div class="flex flex-col gap-0.5">
                  <label class="flex items-center gap-1.5 cursor-pointer hover:bg-blue-50 px-1 py-0.5 rounded transition-colors">
                    <input type="checkbox" class="slicer-link-all accent-blue-600" data-id="${s.id}" ${isAll ? 'checked' : ''}>
                    <span class="${isAll ? 'font-semibold text-blue-700' : 'text-gray-500'}">Tất cả biểu đồ</span>
                  </label>
                  ${viewNames.map(n => {
                    const isLinked = !isAll && linked.includes(n);
                    const esc = n.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
                    return `<label class="flex items-center gap-1.5 cursor-pointer hover:bg-blue-50 px-1 py-0.5 rounded ml-2 transition-colors">
                      <input type="checkbox" class="slicer-link-chart accent-blue-600"
                             data-id="${s.id}" data-chart="${esc}"
                             ${isLinked ? 'checked' : ''} ${isAll ? 'disabled' : ''}>
                      <span class="truncate ${isLinked ? 'text-blue-600 font-medium' : isAll ? 'text-gray-300' : 'text-gray-500'}"
                            title="${esc}">${n}</span>
                    </label>`;
                  }).join('')}
                </div>
              </div>` : ''}
            </div>
          </div>`;
      }).join('');
    }

    // Bind events
    listEl.querySelectorAll('.slicer-del').forEach(btn => {
      btn.addEventListener('click', () => { SlicerService.remove(btn.dataset.id); render(); });
    });

    listEl.querySelectorAll('.slicer-val').forEach(btn => {
      btn.addEventListener('click', () => { SlicerService.toggleValue(btn.dataset.id, btn.dataset.val); render(); });
    });

    listEl.querySelectorAll('.slicer-clear').forEach(btn => {
      btn.addEventListener('click', () => { SlicerService.clearValues(btn.dataset.id); render(); });
    });

    listEl.querySelectorAll('.slicer-link-all').forEach(cb => {
      cb.addEventListener('change', () => {
        SlicerService.setLinkedCharts(cb.dataset.id, cb.checked ? 'all' : []);
        render();
      });
    });

    listEl.querySelectorAll('.slicer-link-chart').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = cb.dataset.id;
        const chart = cb.dataset.chart;
        const s = SlicerService.getAll().find(s => s.id === id);
        if (!s) return;
        let linked = Array.isArray(s.linkedCharts) ? [...s.linkedCharts] : [];
        if (cb.checked) { if (!linked.includes(chart)) linked.push(chart); }
        else { linked = linked.filter(n => n !== chart); }
        SlicerService.setLinkedCharts(id, linked.length ? linked : 'all');
        render();
      });
    });

    // Bind search — lọc pill tại chỗ, không re-render
    listEl.querySelectorAll('.slicer-search').forEach(input => {
      function applyFilter() {
        const q = input.value.toLowerCase().trim();
        const card = input.closest('.slicer-card');
        card.querySelectorAll('.slicer-val').forEach(btn => {
          btn.style.display = !q || btn.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      }
      applyFilter(); // áp dụng ngay nếu có query từ lần trước
      input.addEventListener('input', () => {
        _slicerSearchQueries[input.dataset.id] = input.value;
        applyFilter();
      });
    });

    // Khôi phục scroll position sau khi rebuild HTML
    requestAnimationFrame(() => {
      listEl.scrollTop = listScroll;
      listEl.querySelectorAll('.slicer-card').forEach(card => {
        const saved = valScrolls[card.dataset.slicerId];
        if (saved) {
          const valEl = card.querySelector('.overflow-y-auto');
          if (valEl) valEl.scrollTop = saved;
        }
      });
    });
  }

  function _renderAddSlicerDropdown() {
    const fieldListEl = document.getElementById('add-slicer-field-list');
    if (!fieldListEl) return;

    const existingFields = new Set(SlicerService.getAll().map(s => s.field));
    const available = APP_CONFIG.fieldDefinitions.filter(f => {
      if (existingFields.has(f.key)) return false;
      return _data.some(row => row[f.key] !== undefined && row[f.key] !== null && row[f.key] !== '');
    });

    if (!available.length) {
      fieldListEl.innerHTML = `<p class="text-xs text-gray-400 px-3 py-2 italic">Đã thêm tất cả trường có dữ liệu</p>`;
      return;
    }

    fieldListEl.innerHTML = available.map(f => `
      <button class="add-slicer-field w-full text-left text-xs px-3 py-2 hover:bg-blue-50 hover:text-blue-700
                     text-gray-700 transition-colors border-b border-gray-50 last:border-0"
              data-field="${f.key}">${f.label}</button>
    `).join('');

    fieldListEl.querySelectorAll('.add-slicer-field').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        SlicerService.add(btn.dataset.field);
        document.getElementById('add-slicer-dropdown').style.display = 'none';
        render();
      });
    });
  }

  // ── Init (call once on DOMContentLoaded) ─────────────────────────────────

  function init() {
    const addBtn = document.getElementById('btn-add-slicer');
    const dropdown = document.getElementById('add-slicer-dropdown');
    if (!addBtn || !dropdown) return;

    addBtn.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = dropdown.style.display !== 'none';
      dropdown.style.display = isOpen ? 'none' : '';
      if (!isOpen) _renderAddSlicerDropdown();
    });

    document.addEventListener('click', () => {
      if (dropdown) dropdown.style.display = 'none';
    });

    dropdown.addEventListener('click', e => e.stopPropagation());
  }

  // ── Charts ────────────────────────────────────────────────────────────────

  function render() {
    _renderSlicerPanel();
    _renderCharts();
  }

  function _renderCharts() {
    _destroyAll();
    const container = document.getElementById('dashboard-container');
    if (!container) return;

    const views = DataService.loadPivotViews();
    const order = _loadOrder();

    if (!order.length) {
      container.innerHTML = `
        <div class="col-span-2 flex flex-col items-center justify-center py-24 text-gray-400">
          <svg class="w-16 h-16 mb-4 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2
                 a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14
                 a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
          </svg>
          <p class="text-sm font-medium">Chưa có view nào được lưu</p>
          <p class="text-xs mt-1 text-center">
            Tạo và lưu view trong tab <strong class="text-gray-600">Phân tích</strong> để hiển thị ở đây
          </p>
        </div>`;
      return;
    }

    container.innerHTML = order.map(name => {
      const config = views[name] || {};
      const chartType = config.chartType || 'bar';
      const sortType  = config.chartSort  || 'none';
      const cid = _canvasId(name);
      const hasFilter = SlicerService.getAll().some(s =>
        s.selectedValues.length && (s.linkedCharts === 'all' || (Array.isArray(s.linkedCharts) && s.linkedCharts.includes(name)))
      );
      return `
        <div class="dashboard-card bg-white rounded-xl border-2 ${hasFilter ? 'border-blue-200' : 'border-gray-100'} shadow-sm p-4 flex flex-col gap-2"
             draggable="true" data-name="${name}">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div class="flex items-center gap-2 min-w-0">
              <span class="cursor-grab text-gray-300 hover:text-blue-400 select-none text-xl leading-none"
                    title="Kéo để sắp xếp thứ tự">⠿</span>
              <h3 class="font-semibold text-gray-700 text-sm truncate" title="${name}">${name}</h3>
              ${hasFilter ? `<span class="flex-shrink-0 text-xs text-blue-500 font-medium">⚡ Lọc</span>` : ''}
            </div>
            <div class="flex items-center gap-1.5 flex-shrink-0">
              <select class="dash-sort-sel text-xs border border-gray-200 rounded px-1.5 py-0.5
                             text-gray-600 focus:outline-none focus:border-blue-400 bg-white"
                      data-name="${name}" title="Sắp xếp">
                <option value="none"        ${sortType === 'none'        ? 'selected' : ''}>↕ Sắp xếp</option>
                <option value="value-desc"  ${sortType === 'value-desc'  ? 'selected' : ''}>↓ Giá trị</option>
                <option value="value-asc"   ${sortType === 'value-asc'   ? 'selected' : ''}>↑ Giá trị</option>
                <option value="label-asc"   ${sortType === 'label-asc'   ? 'selected' : ''}>A → Z</option>
                <option value="label-desc"  ${sortType === 'label-desc'  ? 'selected' : ''}>Z → A</option>
              </select>
              <select class="dash-type-sel text-xs border border-gray-200 rounded px-1.5 py-0.5
                             text-gray-600 focus:outline-none focus:border-blue-400 bg-white"
                      data-name="${name}">
                <option value="bar"      ${chartType === 'bar'      ? 'selected' : ''}>Bar</option>
                <option value="line"     ${chartType === 'line'     ? 'selected' : ''}>Line</option>
                <option value="area"     ${chartType === 'area'     ? 'selected' : ''}>Area</option>
                <option value="pie"      ${chartType === 'pie'      ? 'selected' : ''}>Pie</option>
                <option value="doughnut" ${chartType === 'doughnut' ? 'selected' : ''}>Donut</option>
              </select>
            </div>
          </div>
          <div class="relative flex-1" style="min-height:220px">
            <canvas id="${cid}"></canvas>
          </div>
        </div>`;
    }).join('');

    order.forEach((name, cardIndex) => {
      const config = views[name] || {};
      const filteredData = SlicerService.getFilteredData(_data, name);
      const result = PivotEngine.compute(filteredData, config);
      _renderOne(_canvasId(name), result, config.chartType || 'bar', config.chartSort || 'none', cardIndex, filteredData, config);
    });

    container.querySelectorAll('.dash-sort-sel').forEach(sel => {
      sel.addEventListener('change', () => {
        const name = sel.dataset.name;
        const cardIndex = order.indexOf(name);
        const vs = DataService.loadPivotViews();
        if (!vs[name]) return;
        vs[name].chartSort = sel.value;
        localStorage.setItem('crm_pivot_views', JSON.stringify(vs));
        const filteredData = SlicerService.getFilteredData(_data, name);
        _renderOne(_canvasId(name), PivotEngine.compute(filteredData, vs[name]), vs[name].chartType || 'bar', sel.value, cardIndex, filteredData, vs[name]);
      });
    });

    container.querySelectorAll('.dash-type-sel').forEach(sel => {
      sel.addEventListener('change', () => {
        const name = sel.dataset.name;
        const cardIndex = order.indexOf(name);
        const vs = DataService.loadPivotViews();
        if (!vs[name]) return;
        vs[name].chartType = sel.value;
        localStorage.setItem('crm_pivot_views', JSON.stringify(vs));
        const filteredData = SlicerService.getFilteredData(_data, name);
        _renderOne(_canvasId(name), PivotEngine.compute(filteredData, vs[name]), sel.value, vs[name].chartSort || 'none', cardIndex, filteredData, vs[name]);
      });
    });

    _setupDrag(container);
  }

  function _applyCardColors(chartData, chartType, cardIndex) {
    const palette = APP_CONFIG.chartColors;
    const offset = (cardIndex || 0) % palette.length;
    const resolvedType = chartType === 'area' ? 'line' : chartType;
    const isPolar = ['pie', 'doughnut', 'radar'].includes(resolvedType);

    if (isPolar) {
      if (chartData.datasets[0]) {
        chartData.datasets[0].backgroundColor = chartData.labels.map((_, i) =>
          palette[(offset + i) % palette.length]
        );
        chartData.datasets[0].borderColor = '#fff';
        chartData.datasets[0].borderWidth = 2;
      }
    } else if (chartData.datasets.length === 1) {
      // Single series: mỗi bar/điểm có màu riêng
      chartData.datasets[0].backgroundColor = chartData.labels.map((_, i) =>
        palette[(offset + i) % palette.length] + 'CC'
      );
      chartData.datasets[0].borderColor = chartData.labels.map((_, i) =>
        palette[(offset + i) % palette.length]
      );
      chartData.datasets[0].borderWidth = 1;
    } else {
      // Multi series: mỗi series shift màu theo card
      chartData.datasets.forEach((ds, i) => {
        const c = palette[(offset + i) % palette.length];
        ds.backgroundColor = c + 'CC';
        ds.borderColor = c;
        ds.borderWidth = 2;
      });
    }
    return chartData;
  }

  function _renderOne(canvasId, pivotResult, chartType, sortType, cardIndex, drillRawData, drillConfig) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (_charts[canvasId]) { try { _charts[canvasId].destroy(); } catch (_) {} delete _charts[canvasId]; }

    const rawData = ChartRenderer.sortChartData(PivotEngine.toChartData(pivotResult, chartType), sortType || 'none');
    const chartData = _applyCardColors(rawData, chartType, cardIndex);

    let noData = canvas.parentElement.querySelector('.dash-no-data');
    if (!chartData.labels.length) {
      canvas.style.display = 'none';
      if (!noData) {
        noData = document.createElement('div');
        noData.className = 'dash-no-data absolute inset-0 flex items-center justify-center text-gray-300 text-sm';
        noData.textContent = 'Không có dữ liệu';
        canvas.parentElement.appendChild(noData);
      }
      noData.style.display = '';
      return;
    }
    if (noData) noData.style.display = 'none';
    canvas.style.display = '';

    const resolvedType = chartType === 'area' ? 'line' : chartType;
    const isPolar = ['pie', 'doughnut', 'radar'].includes(resolvedType);

    _charts[canvasId] = new Chart(canvas.getContext('2d'), {
      type: resolvedType,
      data: chartData,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: isPolar ? 4 : 18 } },
        onClick: (evt, elements, chart) => {
          try {
            let active = elements && elements.length ? elements
              : (evt.native ? chart.getElementsAtEventForMode(evt.native, 'nearest', { intersect: false }, false) : []);
            if (!active || !active.length) return;
            const el = active[0];
            const rowKey = chartData.labels[el.index];
            const colKey = isPolar ? null : (chartData.datasets[el.datasetIndex]?.label ?? null);
            ChartRenderer.drillFrom(drillRawData || [], drillConfig || {}, rowKey, colKey);
          } catch (e) {
            console.error('[DrillDown] dashboard onClick error:', e);
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
          legend: { position: 'top', labels: { font: { size: 11 }, boxWidth: 12, padding: 8 } },
          tooltip: {
            callbacks: {
              label: ctx => {
                const val = ctx.parsed.y ?? ctx.parsed;
                return ` ${ctx.dataset.label}: ${typeof val === 'number'
                  ? val.toLocaleString('vi-VN', { maximumFractionDigits: 2 }) : val}`;
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
            font: { size: 9, weight: '600' },
            color: isPolar ? '#fff' : '#374151',
          },
        },
        clip: false,
        scales: isPolar ? {} : {
          x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45 } },
          y: { beginAtZero: true, grace: '10%', ticks: { font: { size: 10 } } },
        },
        elements: {
          line: { tension: chartType === 'area' ? 0.4 : 0.1, fill: chartType === 'area' },
        },
      },
    });
  }

  function _setupDrag(container) {
    let dragSrc = null;

    container.querySelectorAll('.dashboard-card').forEach(card => {
      card.addEventListener('dragstart', e => {
        dragSrc = card;
        setTimeout(() => { card.style.opacity = '0.4'; }, 0);
        e.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', () => {
        if (dragSrc) dragSrc.style.opacity = '';
        container.querySelectorAll('.dashboard-card').forEach(c => c.classList.remove('ring-2', 'ring-blue-400'));
      });
      card.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      card.addEventListener('dragenter', e => {
        e.preventDefault();
        if (card !== dragSrc) card.classList.add('ring-2', 'ring-blue-400');
      });
      card.addEventListener('dragleave', () => card.classList.remove('ring-2', 'ring-blue-400'));
      card.addEventListener('drop', e => {
        e.preventDefault();
        card.classList.remove('ring-2', 'ring-blue-400');
        if (!dragSrc || dragSrc === card) return;
        const cards = [...container.querySelectorAll('.dashboard-card')];
        if (cards.indexOf(dragSrc) < cards.indexOf(card)) card.after(dragSrc);
        else card.before(dragSrc);
        _saveOrder([...container.querySelectorAll('.dashboard-card')].map(c => c.dataset.name));
      });
    });
  }

  return { setData, render, init };
})();
