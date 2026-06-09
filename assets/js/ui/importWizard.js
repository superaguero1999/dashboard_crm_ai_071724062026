const ImportWizard = (() => {
  let _workbook = null;
  let _selectedSheet = null;
  let _excelHeaders = [];
  let _colMapping = {};   // fieldKey → colIndex
  let _previewRows = [];
  let _onImportDone = null;

  function open(onDone) {
    _onImportDone = onDone;
    _workbook = null;
    _selectedSheet = null;
    _excelHeaders = [];
    _colMapping = {};
    _previewRows = [];
    renderStep(1);
    document.getElementById('import-modal').classList.remove('hidden');
  }

  function close() {
    document.getElementById('import-modal').classList.add('hidden');
  }

  function renderStep(step) {
    const steps = [1, 2, 3, 4, 5];
    steps.forEach(s => {
      const el = document.getElementById(`import-step-${s}`);
      if (el) el.style.display = s === step ? '' : 'none';
    });

    // Step indicator dots
    steps.forEach(s => {
      const dot = document.getElementById(`step-dot-${s}`);
      if (!dot) return;
      dot.className = s < step
        ? 'w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold bg-blue-500 text-white'
        : s === step
          ? 'w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold bg-blue-600 text-white ring-4 ring-blue-200'
          : 'w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold bg-gray-200 text-gray-500';
    });

    // Footer buttons visibility
    const showHide = (id, show) => {
      const el = document.getElementById(id);
      if (el) el.style.display = show ? '' : 'none';
    };
    showHide('import-step1-next', step === 1);
    showHide('import-step2-back', step === 2);
    showHide('import-step2-next', step === 2);
    showHide('import-step3-back', step === 3);
    showHide('import-step3-next', step === 3);
    showHide('import-step4-back', step === 4);
    showHide('import-step4-next', step === 4);
  }

  // ── Step 1: Upload ────────────────────────────────────────────────────────
  function initStep1() {
    const dropzone = document.getElementById('import-dropzone');
    const fileInput = document.getElementById('import-file-input');

    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('border-blue-500', 'bg-blue-50'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('border-blue-500', 'bg-blue-50'));
    dropzone.addEventListener('drop', e => {
      e.preventDefault();
      dropzone.classList.remove('border-blue-500', 'bg-blue-50');
      const file = e.dataTransfer.files[0];
      if (file) loadFile(file);
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) loadFile(fileInput.files[0]);
    });
  }

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        _workbook = ExcelService.parseWorkbook(e.target.result);
        document.getElementById('import-file-name').textContent = file.name;
        document.getElementById('import-step1-next').disabled = false;
      } catch (err) {
        alert('Không đọc được file Excel: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // ── Step 2: Chọn sheet ────────────────────────────────────────────────────
  function renderStep2() {
    const sheets = ExcelService.getSheetNames(_workbook);
    const container = document.getElementById('sheet-list');
    container.innerHTML = sheets.map((name, i) => `
      <label class="flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-blue-50 transition-colors">
        <input type="radio" name="sheet-select" value="${i}" ${i === 0 ? 'checked' : ''} class="accent-blue-600">
        <span class="font-medium text-gray-700">${name}</span>
      </label>
    `).join('');
    _selectedSheet = sheets[0];
    container.querySelectorAll('input[name=sheet-select]').forEach(inp => {
      inp.addEventListener('change', () => { _selectedSheet = sheets[parseInt(inp.value)]; });
    });
  }

  // ── Step 3: Mapping ───────────────────────────────────────────────────────
  function renderStep3() {
    const ws = _workbook.Sheets[_selectedSheet];
    const headerRow = ExcelService.detectHeaderRow(ws);
    _excelHeaders = ExcelService.extractHeaders(ws, headerRow);
    _colMapping = ExcelService.autoMapFields(_excelHeaders, APP_CONFIG.fieldDefinitions);

    const container = document.getElementById('mapping-table-body');
    container.innerHTML = APP_CONFIG.fieldDefinitions.map(field => {
      const currentCol = _colMapping[field.key];
      const options = `<option value="">— Bỏ qua —</option>` +
        _excelHeaders.map(h => `<option value="${h.col}" ${h.col === currentCol ? 'selected' : ''}>${h.text}</option>`).join('');
      return `
        <tr class="border-b">
          <td class="py-2 pr-4">
            <span class="font-medium text-gray-700">${field.label}</span>
            <span class="ml-1 text-xs text-gray-400">(${field.type})</span>
          </td>
          <td class="py-2">
            <select data-field="${field.key}" class="mapping-select w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-500">
              ${options}
            </select>
          </td>
        </tr>`;
    }).join('');

    container.querySelectorAll('.mapping-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const fieldKey = sel.dataset.field;
        const col = sel.value === '' ? undefined : parseInt(sel.value);
        if (col === undefined) delete _colMapping[fieldKey];
        else _colMapping[fieldKey] = col;
      });
    });
  }

  // ── Step 4: Preview ───────────────────────────────────────────────────────
  function renderStep4() {
    const ws = _workbook.Sheets[_selectedSheet];
    const headerRow = ExcelService.detectHeaderRow(ws);
    _previewRows = ExcelService.parseRows(ws, headerRow, _colMapping).slice(0, 10);

    const mappedFields = APP_CONFIG.fieldDefinitions.filter(f => _colMapping[f.key] !== undefined);
    const thead = `<tr>${mappedFields.map(f => `<th class="px-3 py-2 text-left text-xs font-semibold text-gray-600 bg-gray-50 border-b">${f.label}</th>`).join('')}</tr>`;
    const tbody = _previewRows.map(row =>
      `<tr class="border-b hover:bg-gray-50">${mappedFields.map(f => `<td class="px-3 py-2 text-sm text-gray-700 max-w-xs truncate">${row[f.key] || ''}</td>`).join('')}</tr>`
    ).join('');

    document.getElementById('preview-table').innerHTML = `<thead>${thead}</thead><tbody>${tbody}</tbody>`;

    const ws2 = _workbook.Sheets[_selectedSheet];
    const allRows = ExcelService.parseRows(ws2, headerRow, _colMapping);
    document.getElementById('preview-stats').textContent =
      `${allRows.length} dòng sẽ import · ${mappedFields.length} trường được map`;
  }

  // ── Step 5: Import ────────────────────────────────────────────────────────
  async function runImport() {
    const ws = _workbook.Sheets[_selectedSheet];
    const headerRow = ExcelService.detectHeaderRow(ws);
    const allRows = ExcelService.parseRows(ws, headerRow, _colMapping);

    const progressBar  = document.getElementById('import-progress-bar');
    const progressText = document.getElementById('import-progress-text');
    const dupSummary   = document.getElementById('import-duplicate-summary');
    const dupCount     = document.getElementById('import-dup-count');
    const dupList      = document.getElementById('import-dup-list');

    // Reset duplicate summary
    dupSummary.style.display = 'none';
    dupList.innerHTML = '';

    progressText.textContent = 'Đang tải dữ liệu hiện tại...';
    progressBar.style.width = '5%';

    // Tải records hiện có để merge (DataService tự dùng localStorage khi NocoDB chưa cấu hình)
    const existingRecords = await DataService.fetchAll();

    const existingMap = {};
    for (const rec of existingRecords) {
      existingMap[ExcelService.buildRowKey(rec)] = rec;
    }

    // Phân loại: mới vs trùng
    const newRows = [];
    const dupRows = [];
    for (const row of allRows) {
      const key = ExcelService.buildRowKey(row);
      if (existingMap[key]) dupRows.push(row);
      else newRows.push(row);
    }

    // Hiển thị tóm tắt trùng lặp
    if (dupRows.length > 0) {
      const keyField = APP_CONFIG.rowKeyFields[0] || 'code';
      dupCount.textContent = `⚠ ${dupRows.length} bản ghi trùng (sẽ được cập nhật):`;
      dupList.innerHTML = dupRows
        .map(r => `<span style="display:inline-block;background:#fef3c7;border:1px solid #f59e0b;border-radius:4px;padding:1px 6px;margin:2px;font-size:12px">${r[keyField] || '?'}</span>`)
        .join('');
      dupSummary.style.display = '';
    }

    // Merge: giữ nguyên trường không được map, overwrite trường được map
    const toUpsert = allRows.map(row => {
      const key = ExcelService.buildRowKey(row);
      return { ...(existingMap[key] || {}), ...row };
    });

    progressText.textContent = `Đang import 0 / ${toUpsert.length}...`;

    try {
      await DataService.batchUpsert(toUpsert, {
        onProgress: (done, total) => {
          const pct = Math.round((done / total) * 100);
          progressBar.style.width = `${pct}%`;
          progressText.textContent = `Đang import ${done} / ${total}...`;
        },
      });
    } catch (err) {
      progressText.textContent = `Lỗi: ${err.message}`;
      return;
    }

    progressBar.style.width = '100%';
    const parts = [];
    if (newRows.length > 0) parts.push(`Thêm mới: ${newRows.length}`);
    if (dupRows.length > 0) parts.push(`Cập nhật: ${dupRows.length}`);
    progressText.textContent = `Hoàn tất! ${parts.join(' · ')} bản ghi.`;
    document.getElementById('import-done-btn').style.display = '';

    if (_onImportDone) _onImportDone(toUpsert);
  }

  function init() {
    initStep1();

    document.getElementById('import-step1-next').addEventListener('click', () => {
      renderStep2();
      renderStep(2);
    });
    document.getElementById('import-step2-back').addEventListener('click', () => renderStep(1));
    document.getElementById('import-step2-next').addEventListener('click', () => {
      renderStep3();
      renderStep(3);
    });
    document.getElementById('import-step3-back').addEventListener('click', () => renderStep(2));
    document.getElementById('import-step3-next').addEventListener('click', () => {
      renderStep4();
      renderStep(4);
    });
    document.getElementById('import-step4-back').addEventListener('click', () => renderStep(3));
    document.getElementById('import-step4-next').addEventListener('click', () => {
      renderStep(5);
      document.getElementById('import-done-btn').style.display = 'none';
      runImport();
    });
    document.getElementById('import-done-btn').addEventListener('click', close);
    document.getElementById('import-close-btn').addEventListener('click', close);
  }

  return { open, close, init };
})();
