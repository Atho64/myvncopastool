(() => {
  "use strict";

  const DEFAULT_PROMPT_HEADER = `"""
Localize entire text into Indonesian. These are the rules:
Refine text by using common, natural, and accurate words.
Do not change text structure.
Euphemism prohibited.
Use of "Bahasa Jakarta Selatan" is prohibited.
Use glossary.txt as glossary.
Translate All names.
Put results inside \`\`\`plaintext.
"""`;

  const LINE_REGEX = /^\s*(\d+)\s*[.)]\s*(?:(.*?)\s*[:：]\s*)?(.+?)\s*$/u;
  let PREVIEW_ROW_HEIGHT = window.innerWidth <= 560 ? 80 : 30;
  const PROOFREAD_RENDER_LIMIT = 5000;
  const STORAGE_KEYS = {
    autosave: "vntranslator_web_autosave",
    lastProject: "vntranslator_web_last_project",
  };

  const state = {
    lines: [],
    importedFiles: [],
    nameTable: {},
    aiInstructionHeader: DEFAULT_PROMPT_HEADER,
    undoSnapshot: null,
    selectedFrom: 1,
    selectedTo: 1,
    sourceLabel: "",
    displayRows: [],
    lineByNum: new Map(),
    lastCopiedRange: null,
  };

  const ui = {};
  let activeLineEditorLineNum = null;
  let previewRenderQueued = false;

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheElements();
    bindEvents();
    refreshAll();
    showStartupModal();
  }

  function cacheElements() {
    const ids = [
      "btnImportFile",
      "btnImportFolder",
      "btnImportZip",
      "btnExport",
      "btnProofread",
      "btnSettings",
      "btnSaveSession",
      "btnLoadSession",
      "toolbarHint",
      "previewViewport",
      "previewSpacer",
      "previewRowsLayer",
      "progressFill",
      "progressText",
      "fromInput",
      "toInput",
      "btnCopyForAi",
      "copyStatus",
      "pasteArea",
      "btnApply",
      "btnUndo",
      "nameTableBody",
      "btnAddName",
      "statusBar",
      "importFileInput",
      "importFolderInput",
      "importZipInput",
      "loadSessionInput",
      "startupModal",
      "startupInfo",
      "btnStartupLast",
      "btnStartupLoad",
      "btnStartupNew",
      "settingsModal",
      "settingsPromptInput",
      "btnSettingsReset",
      "btnSettingsCancel",
      "btnSettingsSave",
      "lineEditorModal",
      "lineEditorTitle",
      "lineEditorInfo",
      "lineOriginalView",
      "lineNameWrap",
      "lineNameInput",
      "lineMessageInput",
      "lineTranslatedCheck",
      "btnLineCancel",
      "btnLineSave",
      "proofreadModal",
      "proofreadSearchInput",
      "proofreadRegexCheck",
      "proofreadCaseCheck",
      "proofreadTranslatedOnlyCheck",
      "btnProofreadSearch",
      "btnProofreadReset",
      "proofreadStatus",
      "proofreadTableBody",
      "btnProofreadClose",
    ];

    for (const id of ids) {
      ui[id] = document.getElementById(id);
    }
  }

  function bindEvents() {
    ui.btnImportFile.addEventListener("click", () => ui.importFileInput.click());
    ui.btnImportFolder.addEventListener("click", () => ui.importFolderInput.click());
    ui.btnImportZip.addEventListener("click", () => ui.importZipInput.click());
    ui.btnLoadSession.addEventListener("click", () => ui.loadSessionInput.click());

    ui.importFileInput.addEventListener("change", onImportFileChange);
    ui.importFolderInput.addEventListener("change", onImportFolderChange);
    ui.importZipInput.addEventListener("change", onImportZipChange);
    ui.loadSessionInput.addEventListener("change", onLoadSessionChange);

    ui.btnExport.addEventListener("click", onExport);
    ui.btnSaveSession.addEventListener("click", onSaveSession);
    ui.btnCopyForAi.addEventListener("click", onCopyForAi);
    ui.btnApply.addEventListener("click", onApplyTranslation);
    ui.btnUndo.addEventListener("click", onUndoLastApply);
    ui.btnAddName.addEventListener("click", onAddName);
    ui.btnProofread.addEventListener("click", onOpenProofread);

    ui.fromInput.addEventListener("change", onRangeInputChanged);
    ui.toInput.addEventListener("change", onRangeInputChanged);

    ui.previewViewport.addEventListener("scroll", queuePreviewRender);

    ui.btnSettings.addEventListener("click", onOpenSettings);
    ui.btnSettingsReset.addEventListener("click", () => {
      ui.settingsPromptInput.value = DEFAULT_PROMPT_HEADER;
    });
    ui.btnSettingsCancel.addEventListener("click", () => closeModal(ui.settingsModal));
    ui.btnSettingsSave.addEventListener("click", onSavePromptSettings);

    ui.btnLineCancel.addEventListener("click", () => closeModal(ui.lineEditorModal));
    ui.btnLineSave.addEventListener("click", onSaveLineEditor);

    ui.btnProofreadClose.addEventListener("click", () => closeModal(ui.proofreadModal));
    ui.btnProofreadSearch.addEventListener("click", renderProofreadResults);
    ui.btnProofreadReset.addEventListener("click", onResetProofread);
    ui.proofreadSearchInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        renderProofreadResults();
      }
    });

    ui.btnStartupLast.addEventListener("click", onStartupLastProject);
    ui.btnStartupLoad.addEventListener("click", () => {
      closeModal(ui.startupModal);
      ui.loadSessionInput.click();
    });
    ui.btnStartupNew.addEventListener("click", () => closeModal(ui.startupModal));

    window.addEventListener("resize", () => {
      const newHeight = window.innerWidth <= 560 ? 80 : 30;
      if (newHeight !== PREVIEW_ROW_HEIGHT) {
        PREVIEW_ROW_HEIGHT = newHeight;
        queuePreviewRender();
      }
    });
  }

  function isTranslated(line) {
    return Boolean(line.is_translated) && Boolean((line.trans_message || "").trim());
  }

  function normalizeLineDict(line) {
    return {
      line_num: Number(line.line_num) || 0,
      file: String(line.file || ""),
      name: line.name == null ? null : String(line.name),
      message: String(line.message || ""),
      trans_name: line.trans_name == null ? null : String(line.trans_name),
      trans_message: line.trans_message == null ? null : String(line.trans_message),
      is_translated: Boolean(line.is_translated),
    };
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function normalizeFileBaseName(pathOrName) {
    const normalized = String(pathOrName || "").replace(/\\/g, "/");
    const justName = normalized.split("/").pop() || normalized;
    let base = justName.replace(/\.json$/i, "");
    if (base.toLowerCase().endsWith("_translated")) {
      base = base.slice(0, -"_translated".length);
    }
    return base;
  }

  function shouldSkipJsonPath(pathOrName) {
    return /_translated\.json$/i.test(String(pathOrName || ""));
  }

  function decodeArrayBuffer(buffer) {
    const encodings = ["utf-8", "shift_jis", "windows-31j"];
    for (const enc of encodings) {
      try {
        return new TextDecoder(enc, { fatal: true }).decode(buffer);
      } catch (_err) {
        continue;
      }
    }
    return new TextDecoder("utf-8").decode(buffer);
  }

  async function parseJsonFromFileObject(file) {
    const arr = await file.arrayBuffer();
    const text = decodeArrayBuffer(arr);
    return JSON.parse(text);
  }

  function parseJsonEntries(jsonArray, fileName, startLineNum) {
    if (!Array.isArray(jsonArray)) {
      throw new Error(`File ${fileName} tidak berisi array JSON.`);
    }

    const lines = [];
    let currentLine = startLineNum;
    for (const entry of jsonArray) {
      if (!entry || typeof entry !== "object" || !Object.prototype.hasOwnProperty.call(entry, "message")) {
        continue;
      }
      lines.push({
        line_num: currentLine,
        file: fileName,
        name: entry.name == null ? null : String(entry.name),
        message: String(entry.message ?? ""),
        trans_name: null,
        trans_message: null,
        is_translated: false,
      });
      currentLine += 1;
    }
    return lines;
  }

  function rebuildDisplayState() {
    state.lineByNum = new Map();
    for (const line of state.lines) {
      state.lineByNum.set(line.line_num, line);
    }

    const grouped = new Map();
    for (const fileName of state.importedFiles) {
      grouped.set(fileName, []);
    }
    for (const line of state.lines) {
      if (!grouped.has(line.file)) grouped.set(line.file, []);
      grouped.get(line.file).push(line);
    }

    state.displayRows = [];
    for (const [fileName, rows] of grouped.entries()) {
      if (!rows.length) continue;
      state.displayRows.push({ type: "separator", file: fileName });
      for (const line of rows) {
        state.displayRows.push({ type: "line", line });
      }
    }
  }

  function maxLineNum() {
    if (!state.lines.length) return 1;
    return state.lines[state.lines.length - 1].line_num;
  }

  function clampRangeValues() {
    const maxLine = maxLineNum();
    state.selectedFrom = Math.min(Math.max(1, Number(state.selectedFrom) || 1), maxLine);
    state.selectedTo = Math.min(Math.max(1, Number(state.selectedTo) || 1), maxLine);
  }

  function refreshRangeInputs() {
    const maxLine = maxLineNum();
    ui.fromInput.min = "1";
    ui.toInput.min = "1";
    ui.fromInput.max = String(maxLine);
    ui.toInput.max = String(maxLine);
    ui.fromInput.value = String(state.selectedFrom);
    ui.toInput.value = String(state.selectedTo);
  }

  function selectedRange() {
    const lo = Math.min(state.selectedFrom, state.selectedTo);
    const hi = Math.max(state.selectedFrom, state.selectedTo);
    return [lo, hi];
  }

  function formatOriginalLineText(line) {
    if (line.name) {
      return `${line.line_num}. ${line.name}: ${line.message}`;
    }
    return `${line.line_num}. ${line.message}`;
  }

  function formatTranslatedLineText(line) {
    const transMessage = (line.trans_message || "").trim();
    if (!isTranslated(line) || !transMessage) {
      return "——";
    }
    const mappedName = line.name ? (state.nameTable[line.name] || "").trim() : "";
    const transName = (line.trans_name || "").trim() || mappedName;
    if (transName) {
      return `${line.line_num}. ${transName}: ${transMessage}`;
    }
    return `${line.line_num}. ${transMessage}`;
  }

  function queuePreviewRender() {
    if (previewRenderQueued) return;
    previewRenderQueued = true;
    requestAnimationFrame(() => {
      previewRenderQueued = false;
      renderPreviewRows();
    });
  }

  function renderPreviewRows() {
    const totalRows = state.displayRows.length;
    ui.previewSpacer.style.height = `${totalRows * PREVIEW_ROW_HEIGHT}px`;
    ui.previewRowsLayer.textContent = "";

    if (!totalRows) return;

    const [selectedLo, selectedHi] = selectedRange();
    const viewportHeight = ui.previewViewport.clientHeight || 500;
    const scrollTop = ui.previewViewport.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / PREVIEW_ROW_HEIGHT) - 8);
    const end = Math.min(
      totalRows,
      Math.ceil((scrollTop + viewportHeight) / PREVIEW_ROW_HEIGHT) + 8
    );

    const frag = document.createDocumentFragment();
    for (let idx = start; idx < end; idx += 1) {
      const rowData = state.displayRows[idx];
      const row = document.createElement("div");
      row.className = "preview-row";
      row.style.top = `${idx * PREVIEW_ROW_HEIGHT}px`;

      if (rowData.type === "separator") {
        row.classList.add("separator");
        const cell = document.createElement("div");
        cell.className = "cell";
        cell.textContent = `=== ${rowData.file} ===`;
        row.appendChild(cell);
      } else {
        const line = rowData.line;
        const translated = isTranslated(line);
        const inRange = line.line_num >= selectedLo && line.line_num <= selectedHi;
        if (inRange) {
          row.classList.add("row-selected");
        } else if (translated) {
          row.classList.add("row-translated");
        } else {
          row.classList.add("row-untranslated");
        }

        const left = document.createElement("div");
        left.className = "cell";
        left.textContent = formatOriginalLineText(line);
        left.title = left.textContent;

        const right = document.createElement("div");
        right.className = "cell";
        right.textContent = formatTranslatedLineText(line);
        right.title = right.textContent;
        if (!translated) right.classList.add("cell-muted");

        row.appendChild(left);
        row.appendChild(right);

        row.addEventListener("click", () => {
          state.selectedFrom = line.line_num;
          if (state.selectedTo < state.selectedFrom) state.selectedTo = state.selectedFrom;
          refreshRangeInputs();
          renderPreviewRows();
        });
        row.addEventListener("dblclick", () => {
          openLineEditor(line.line_num);
        });
      }

      frag.appendChild(row);
    }

    ui.previewRowsLayer.appendChild(frag);
  }

  function renderNameTable() {
    const knownNames = [];
    for (const line of state.lines) {
      if (line.name) knownNames.push(line.name);
    }
    const uniqueKnownNames = [...new Set(knownNames)];
    for (const name of uniqueKnownNames) {
      if (!Object.prototype.hasOwnProperty.call(state.nameTable, name)) {
        state.nameTable[name] = "";
      }
    }

    ui.nameTableBody.textContent = "";
    for (const originalName of Object.keys(state.nameTable)) {
      const tr = document.createElement("tr");

      const tdOrig = document.createElement("td");
      tdOrig.textContent = originalName;
      tdOrig.className = "mono";

      const tdInput = document.createElement("td");
      const input = document.createElement("input");
      input.type = "text";
      input.value = state.nameTable[originalName] || "";
      input.className = "mono text-input";
      input.addEventListener("input", () => {
        state.nameTable[originalName] = input.value.trim();
        renderPreviewRows();
      });
      tdInput.appendChild(input);

      const tdApply = document.createElement("td");
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.textContent = "Terapkan";
      btn.addEventListener("click", () => {
        const mapped = input.value.trim();
        state.nameTable[originalName] = mapped;
        const changed = applyNameToLines(originalName, mapped);
        renderPreviewRows();
        updateStatusBar();
        autoSaveProject("apply_name");
        flashHint(`${changed} baris nama diterapkan untuk '${originalName}'.`);
      });
      tdApply.appendChild(btn);

      tr.appendChild(tdOrig);
      tr.appendChild(tdInput);
      tr.appendChild(tdApply);
      ui.nameTableBody.appendChild(tr);
    }
  }

  function applyNameToLines(originalName, mappedName) {
    let changed = 0;
    const newValue = mappedName || null;
    for (const line of state.lines) {
      if ((line.name || "").trim() !== originalName) continue;
      if (line.trans_name === newValue) continue;
      line.trans_name = newValue;
      changed += 1;
    }
    renderProofreadResultsIfOpen();
    return changed;
  }

  function updateStatusBar() {
    const total = state.lines.length;
    let translated = 0;
    for (const line of state.lines) {
      if (isTranslated(line)) translated += 1;
    }
    const percent = total ? Math.floor((translated / total) * 100) : 0;
    let fileLabel = "-";
    if (state.importedFiles.length === 1) fileLabel = state.importedFiles[0];
    else if (state.importedFiles.length > 1) fileLabel = `${state.importedFiles.length} file`;

    ui.statusBar.textContent = `File: ${fileLabel} | Baris: ${total} | Diterjemahkan: ${translated}/${total} (${percent}%)`;
    ui.progressFill.style.width = total ? `${(translated / total) * 100}%` : "0%";
    ui.progressText.textContent = `${translated}/${total}`;
  }

  function refreshAll() {
    rebuildDisplayState();
    clampRangeValues();
    refreshRangeInputs();
    renderNameTable();
    renderPreviewRows();
    updateStatusBar();
    ui.btnUndo.disabled = !state.undoSnapshot;
  }

  function clearUndo() {
    state.undoSnapshot = null;
    ui.btnUndo.disabled = true;
  }

  function flashHint(message) {
    ui.copyStatus.textContent = message;
    setTimeout(() => {
      if (ui.copyStatus.textContent === message) {
        ui.copyStatus.textContent = "";
      }
    }, 4000);
  }

  function onRangeInputChanged() {
    state.selectedFrom = Number(ui.fromInput.value) || 1;
    state.selectedTo = Number(ui.toInput.value) || 1;
    clampRangeValues();
    refreshRangeInputs();
    renderPreviewRows();
  }

  function autoSaveCurrentProjectBeforeImport() {
    if (!state.lines.length) return;
    autoSaveProject("before_import");
  }

  function applyImportResult(lines, importedFiles, sourceLabel) {
    state.lines = lines;
    state.importedFiles = importedFiles;
    state.nameTable = {};
    state.sourceLabel = sourceLabel || "";
    state.lastCopiedRange = null;
    state.selectedFrom = 1;
    state.selectedTo = Math.min(30, Math.max(lines.length, 1));
    ui.pasteArea.value = "";
    clearUndo();
    refreshAll();
    autoSaveProject("after_import");
  }

  async function onImportFileChange(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    if (!/\.json$/i.test(file.name) || shouldSkipJsonPath(file.name)) {
      alert("Pilih file JSON yang valid.");
      return;
    }

    try {
      const parsed = await parseJsonFromFileObject(file);
      const fileName = normalizeFileBaseName(file.name);
      const lines = parseJsonEntries(parsed, fileName, 1);
      autoSaveCurrentProjectBeforeImport();
      applyImportResult(lines, [fileName], file.name);
    } catch (err) {
      alert(`Gagal impor file: ${err.message || err}`);
    }
  }

  async function onImportFolderChange(ev) {
    const allFiles = Array.from(ev.target.files || []);
    ev.target.value = "";
    const jsonFiles = allFiles
      .filter((f) => /\.json$/i.test(f.name))
      .filter((f) => !shouldSkipJsonPath(f.webkitRelativePath || f.name));
    jsonFiles.sort((a, b) => {
      const pa = (a.webkitRelativePath || a.name).toLowerCase();
      const pb = (b.webkitRelativePath || b.name).toLowerCase();
      return pa.localeCompare(pb);
    });

    if (!jsonFiles.length) {
      alert("Tidak ada file JSON valid di folder.");
      return;
    }

    try {
      let currentLine = 1;
      const lines = [];
      const importedFiles = [];

      for (const file of jsonFiles) {
        const parsed = await parseJsonFromFileObject(file);
        const fileName = normalizeFileBaseName(file.name);
        const parsedLines = parseJsonEntries(parsed, fileName, currentLine);
        if (!parsedLines.length) continue;
        importedFiles.push(fileName);
        lines.push(...parsedLines);
        currentLine += parsedLines.length;
      }

      if (!lines.length) {
        alert("Tidak ada konten JSON valid untuk diimpor.");
        return;
      }

      autoSaveCurrentProjectBeforeImport();
      applyImportResult(lines, importedFiles, jsonFiles[0].webkitRelativePath || "Folder");
    } catch (err) {
      alert(`Gagal impor folder: ${err.message || err}`);
    }
  }

  async function onImportZipChange(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    if (!window.JSZip) {
      alert("JSZip belum termuat. Coba refresh halaman lalu ulangi.");
      return;
    }

    try {
      const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
      const names = Object.keys(zip.files)
        .filter((name) => !zip.files[name].dir)
        .filter((name) => /\.json$/i.test(name))
        .filter((name) => !shouldSkipJsonPath(name))
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      if (!names.length) {
        alert("Tidak ada file JSON valid di ZIP.");
        return;
      }

      let currentLine = 1;
      const lines = [];
      const importedFiles = [];

      for (const name of names) {
        const entry = zip.file(name);
        if (!entry) continue;
        const data = await entry.async("uint8array");
        const text = decodeArrayBuffer(data.buffer);
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (_err) {
          continue;
        }

        const fileName = normalizeFileBaseName(name);
        let parsedLines;
        try {
          parsedLines = parseJsonEntries(parsed, fileName, currentLine);
        } catch (_err) {
          continue;
        }
        if (!parsedLines.length) continue;
        importedFiles.push(fileName);
        lines.push(...parsedLines);
        currentLine += parsedLines.length;
      }

      if (!lines.length) {
        alert("ZIP tidak berisi array JSON script yang valid.");
        return;
      }

      autoSaveCurrentProjectBeforeImport();
      applyImportResult(lines, importedFiles, file.name);
    } catch (err) {
      alert(`Gagal impor ZIP: ${err.message || err}`);
    }
  }

  function linesToReadable(fromNum, toNum) {
    const lo = Math.min(fromNum, toNum);
    const hi = Math.max(fromNum, toNum);
    const selected = state.lines.filter((line) => line.line_num >= lo && line.line_num <= hi);
    if (!selected.length) return "";

    const out = [];
    let currentFile = "";
    for (const line of selected) {
      if (line.file !== currentFile) {
        if (out.length) out.push("");
        out.push(`# ${line.file}`);
        out.push("");
        currentFile = line.file;
      }
      if (line.name) {
        out.push(`${line.line_num}.  ${line.name}: ${line.message}`);
      } else {
        out.push(`${line.line_num}.  ${line.message}`);
      }
    }
    return out.join("\n").trim();
  }

  function buildAiPrompt(fromNum, toNum) {
    const readable = linesToReadable(fromNum, toNum);
    const header = (state.aiInstructionHeader || DEFAULT_PROMPT_HEADER).trim();
    if (!readable) return `${header}\n`;
    return `${header}\n\n${readable}\n`;
  }

  async function onCopyForAi() {
    if (!state.lines.length) {
      alert("Belum ada data untuk disalin.");
      return;
    }
    const fromNum = Number(ui.fromInput.value) || 1;
    const toNum = Number(ui.toInput.value) || 1;
    const prompt = buildAiPrompt(fromNum, toNum);
    const lo = Math.min(fromNum, toNum);
    const hi = Math.max(fromNum, toNum);

    try {
      await navigator.clipboard.writeText(prompt);
      flashHint(`OK. Disalin baris ${lo}-${hi} ke papan klip.`);
    } catch (_err) {
      ui.pasteArea.value = prompt;
      flashHint("Clipboard ditolak browser. Prompt dimasukkan ke area paste.");
    }
    state.selectedFrom = lo;
    state.selectedTo = hi;
    state.lastCopiedRange = { from: lo, to: hi };
    refreshRangeInputs();
    renderPreviewRows();
  }

  function parseReadableTranslations(text) {
    const entries = [];
    const malformedLines = [];
    const rows = String(text || "").split(/\r?\n/);
    for (let idx = 0; idx < rows.length; idx += 1) {
      const raw = rows[idx];
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#") || line.startsWith('"""') || line.startsWith("```")) continue;

      if (!/^\d+/.test(line)) continue;

      const match = line.match(LINE_REGEX);
      if (!match) {
        malformedLines.push({ input_row: idx + 1, text: line });
        continue;
      }

      const lineNum = Number(match[1]);
      const rawName = (match[2] || "").trim();
      const message = (match[3] || "").trim();
      if (!lineNum || !message) {
        malformedLines.push({ input_row: idx + 1, text: line });
        continue;
      }

      entries.push({
        line_num: lineNum,
        name: rawName || null,
        message,
      });
    }
    return { entries, malformedLines };
  }

  function summarizeLineNums(nums, limit) {
    const safeLimit = Math.max(1, Number(limit) || 8);
    const uniqueSorted = [...new Set(nums)].sort((a, b) => a - b);
    if (!uniqueSorted.length) return "-";
    const shown = uniqueSorted.slice(0, safeLimit).join(", ");
    if (uniqueSorted.length <= safeLimit) return shown;
    return `${shown}, ... (+${uniqueSorted.length - safeLimit})`;
  }

  function summarizeMalformedLines(malformedLines, limit) {
    const safeLimit = Math.max(1, Number(limit) || 3);
    if (!malformedLines.length) return "";
    const snippets = malformedLines.slice(0, safeLimit).map((item) => {
      const snippet = item.text.length > 42 ? `${item.text.slice(0, 42)}...` : item.text;
      return `baris input #${item.input_row} ("${snippet}")`;
    });
    const suffix = malformedLines.length > safeLimit
      ? `, +${malformedLines.length - safeLimit} baris lain`
      : "";
    return `${snippets.join("; ")}${suffix}`;
  }

  function getExpectedApplyRange() {
    const [selectedLo, selectedHi] = selectedRange();
    if (
      state.lastCopiedRange &&
      Number.isInteger(state.lastCopiedRange.from) &&
      Number.isInteger(state.lastCopiedRange.to) &&
      state.lastCopiedRange.from > 0 &&
      state.lastCopiedRange.to > 0
    ) {
      const copiedLo = Math.min(state.lastCopiedRange.from, state.lastCopiedRange.to);
      const copiedHi = Math.max(state.lastCopiedRange.from, state.lastCopiedRange.to);
      if (copiedLo === selectedLo && copiedHi === selectedHi) {
        return [copiedLo, copiedHi];
      }
    }
    return [selectedLo, selectedHi];
  }

  function analyzeApplyAnomalies(entries, expectedLo, expectedHi) {
    const freq = new Map();
    const unknownNums = new Set();
    const outOfRangeNums = new Set();
    const knownInRangeNums = new Set();
    let nonAscendingCount = 0;
    let previousLineNum = null;

    for (const item of entries) {
      const num = item.line_num;
      freq.set(num, (freq.get(num) || 0) + 1);
      if (previousLineNum != null && num < previousLineNum) {
        nonAscendingCount += 1;
      }
      previousLineNum = num;

      const line = state.lineByNum.get(num);
      if (!line) {
        unknownNums.add(num);
        continue;
      }
      if (num < expectedLo || num > expectedHi) {
        outOfRangeNums.add(num);
        continue;
      }
      knownInRangeNums.add(num);
    }

    const duplicateLineNums = [];
    let duplicateExtraCount = 0;
    for (const [num, count] of freq.entries()) {
      if (count > 1) {
        duplicateLineNums.push(num);
        duplicateExtraCount += (count - 1);
      }
    }
    duplicateLineNums.sort((a, b) => a - b);

    const missingNums = [];
    for (let num = expectedLo; num <= expectedHi; num += 1) {
      if (!knownInRangeNums.has(num)) {
        missingNums.push(num);
      }
    }

    const expectedCount = Math.max(0, expectedHi - expectedLo + 1);
    return {
      expectedCount,
      parsedCount: entries.length,
      uniqueCount: freq.size,
      duplicateLineNums,
      duplicateExtraCount,
      nonAscendingCount,
      unknownLineNums: [...unknownNums].sort((a, b) => a - b),
      outOfRangeLineNums: [...outOfRangeNums].sort((a, b) => a - b),
      missingLineNums: missingNums,
    };
  }

  function buildApplyAnomalyMessage(parseResult, anomaly, expectedLo, expectedHi) {
    const details = [];

    if (anomaly.uniqueCount !== anomaly.expectedCount) {
      details.push(
        `Jumlah nomor unik (${anomaly.uniqueCount}) tidak sama dengan rentang target ${expectedLo}-${expectedHi} (${anomaly.expectedCount}).`
      );
    }
    if (anomaly.nonAscendingCount > 0) {
      details.push(
        `Nomor baris tidak urut naik di ${anomaly.nonAscendingCount} titik (indikasi urutan acak).`
      );
    }
    if (anomaly.duplicateLineNums.length) {
      details.push(
        `Nomor duplikat terdeteksi: ${summarizeLineNums(anomaly.duplicateLineNums, 10)} (entri terakhir yang dipakai).`
      );
    }
    if (anomaly.missingLineNums.length) {
      details.push(
        `Nomor yang hilang dari rentang target: ${summarizeLineNums(anomaly.missingLineNums, 10)}.`
      );
    }
    if (anomaly.outOfRangeLineNums.length) {
      details.push(
        `Nomor valid tapi di luar rentang target: ${summarizeLineNums(anomaly.outOfRangeLineNums, 10)}.`
      );
    }
    if (anomaly.unknownLineNums.length) {
      details.push(
        `Nomor tidak ditemukan di proyek aktif: ${summarizeLineNums(anomaly.unknownLineNums, 10)}.`
      );
    }
    if (parseResult.malformedLines.length) {
      details.push(
        `Format baris tidak dikenali: ${parseResult.malformedLines.length} baris (${summarizeMalformedLines(parseResult.malformedLines, 3)}).`
      );
    }

    if (!details.length) return "";

    return [
      "Terdeteksi anomali pada hasil paste AI:",
      ...details.map((line) => `- ${line}`),
      "",
      "Tetap lanjutkan penerapan terjemahan?",
    ].join("\n");
  }

  function onApplyTranslation() {
    if (!state.lines.length) {
      alert("Belum ada data.");
      return;
    }
    const parseResult = parseReadableTranslations(ui.pasteArea.value);
    if (!parseResult.entries.length) {
      alert("Tidak ada baris valid terbaca.");
      return;
    }

    const [expectedLo, expectedHi] = getExpectedApplyRange();
    const anomaly = analyzeApplyAnomalies(parseResult.entries, expectedLo, expectedHi);
    const anomalyMessage = buildApplyAnomalyMessage(parseResult, anomaly, expectedLo, expectedHi);

    if (anomalyMessage) {
      const proceed = window.confirm(anomalyMessage);
      if (!proceed) {
        flashHint("Penerapan dibatalkan agar bisa cek hasil paste dulu.");
        return;
      }
    }

    const latestByLine = new Map();
    for (const item of parseResult.entries) {
      latestByLine.set(item.line_num, item);
    }

    const plannedUpdates = [];
    let skippedUnknown = 0;
    for (const item of latestByLine.values()) {
      const line = state.lineByNum.get(item.line_num);
      if (!line) {
        skippedUnknown += 1;
        continue;
      }
      const msg = (item.message || "").trim();
      if (!msg) {
        skippedUnknown += 1;
        continue;
      }
      plannedUpdates.push({ line, item, msg });
    }

    if (!plannedUpdates.length) {
      alert("Tidak ada perubahan yang diterapkan.");
      return;
    }

    state.undoSnapshot = {
      lines: deepClone(state.lines),
      nameTable: { ...state.nameTable },
    };
    ui.btnUndo.disabled = false;

    let affected = 0;
    for (const update of plannedUpdates) {
      const { line, item, msg } = update;

      line.trans_message = msg;
      line.is_translated = true;

      const parsedName = (item.name || "").trim();
      if (parsedName) {
        line.trans_name = parsedName;
        const originalName = (line.name || "").trim();
        if (originalName && !(state.nameTable[originalName] || "").trim()) {
          state.nameTable[originalName] = parsedName;
        }
      }
      affected += 1;
    }

    ui.pasteArea.value = "";
    renderNameTable();
    renderPreviewRows();
    updateStatusBar();
    renderProofreadResultsIfOpen();
    autoSaveProject("apply_translation");

    const anomalySkipped =
      skippedUnknown + anomaly.duplicateExtraCount + parseResult.malformedLines.length;
    if (anomalySkipped) {
      flashHint(`OK. ${affected} baris diterapkan. Dilewati/anomali: ${anomalySkipped}.`);
    } else {
      flashHint(`OK. ${affected} baris berhasil diterjemahkan.`);
    }
  }

  function onUndoLastApply() {
    if (!state.undoSnapshot) return;
    state.lines = state.undoSnapshot.lines.map(normalizeLineDict);
    state.nameTable = { ...state.undoSnapshot.nameTable };
    clearUndo();
    refreshAll();
    renderProofreadResultsIfOpen();
    autoSaveProject("undo");
    flashHint("Undo berhasil.");
  }

  function onAddName() {
    const original = window.prompt("Nama asli:");
    if (!original) return;
    const trimmedOriginal = original.trim();
    if (!trimmedOriginal) return;
    const trans = window.prompt("Terjemahan (boleh kosong):", state.nameTable[trimmedOriginal] || "") || "";
    state.nameTable[trimmedOriginal] = trans.trim();
    renderNameTable();
    renderPreviewRows();
    autoSaveProject("add_name");
  }

  function openLineEditor(lineNum) {
    const line = state.lineByNum.get(lineNum);
    if (!line) return;
    activeLineEditorLineNum = lineNum;

    ui.lineEditorTitle.textContent = `Edit Terjemahan - Baris ${lineNum}`;
    ui.lineEditorInfo.textContent = `File: ${line.file} | Baris: ${lineNum}`;
    ui.lineOriginalView.value = formatOriginalLineText(line);

    const hasName = Boolean(line.name);
    ui.lineNameWrap.style.display = hasName ? "block" : "none";
    ui.lineNameInput.value = hasName ? (line.trans_name || "") : "";
    ui.lineMessageInput.value = (line.trans_message || "").trim();
    ui.lineTranslatedCheck.checked = isTranslated(line);
    openModal(ui.lineEditorModal);
  }

  function onSaveLineEditor() {
    if (!activeLineEditorLineNum) return;
    const line = state.lineByNum.get(activeLineEditorLineNum);
    if (!line) return;

    const transMessage = ui.lineMessageInput.value.trim();
    const markTranslated = ui.lineTranslatedCheck.checked;
    if (markTranslated && !transMessage) {
      alert("Jika ditandai sudah diterjemahkan, isi terjemahan tidak boleh kosong.");
      return;
    }

    line.trans_message = transMessage || null;
    line.is_translated = Boolean(markTranslated && transMessage);

    if (line.name) {
      const transName = ui.lineNameInput.value.trim();
      line.trans_name = transName || null;
      if (transName && !(state.nameTable[line.name] || "").trim()) {
        state.nameTable[line.name] = transName;
      }
    } else {
      line.trans_name = null;
    }

    closeModal(ui.lineEditorModal);
    renderNameTable();
    renderPreviewRows();
    updateStatusBar();
    renderProofreadResultsIfOpen();
    autoSaveProject("line_edit");
    flashHint(`Baris ${line.line_num} diperbarui.`);
  }

  function onOpenProofread() {
    if (!state.lines.length) {
      alert("Belum ada data untuk diperiksa.");
      return;
    }
    openModal(ui.proofreadModal);
    renderProofreadResults();
  }

  function onResetProofread() {
    ui.proofreadSearchInput.value = "";
    ui.proofreadRegexCheck.checked = false;
    ui.proofreadCaseCheck.checked = false;
    ui.proofreadTranslatedOnlyCheck.checked = true;
    renderProofreadResults();
  }

  function renderProofreadResultsIfOpen() {
    if (!ui.proofreadModal.classList.contains("open")) return;
    renderProofreadResults();
  }

  function renderProofreadResults() {
    if (!ui.proofreadModal.classList.contains("open")) return;

    const query = ui.proofreadSearchInput.value || "";
    const useRegex = ui.proofreadRegexCheck.checked;
    const caseSensitive = ui.proofreadCaseCheck.checked;
    const translatedOnly = ui.proofreadTranslatedOnlyCheck.checked;

    let regex = null;
    if (query && useRegex) {
      try {
        regex = new RegExp(query, caseSensitive ? "" : "i");
      } catch (err) {
        ui.proofreadStatus.textContent = `Regex tidak valid: ${err.message}`;
        ui.proofreadTableBody.textContent = "";
        return;
      }
    }

    const matches = [];
    for (const line of state.lines) {
      const translated = isTranslated(line);
      if (translatedOnly && !translated) continue;

      const original = line.name ? `${line.name}: ${line.message}` : line.message;
      const translatedText = formatTranslatedLineText(line);
      const target = `${original}\n${translatedText}`;

      let ok = true;
      if (query) {
        if (regex) {
          ok = regex.test(target);
        } else if (caseSensitive) {
          ok = target.includes(query);
        } else {
          ok = target.toLowerCase().includes(query.toLowerCase());
        }
      }
      if (!ok) continue;

      matches.push({
        line_num: line.line_num,
        file: line.file,
        original,
        translated: translatedText,
      });
    }

    const totalMatches = matches.length;
    const limited = matches.slice(0, PROOFREAD_RENDER_LIMIT);

    ui.proofreadTableBody.textContent = "";
    const frag = document.createDocumentFragment();
    for (const row of limited) {
      const tr = document.createElement("tr");
      tr.style.cursor = "pointer";

      const tdLine = document.createElement("td");
      tdLine.textContent = String(row.line_num);
      const tdFile = document.createElement("td");
      tdFile.textContent = row.file;
      const tdOrig = document.createElement("td");
      tdOrig.textContent = row.original;
      const tdTrans = document.createElement("td");
      tdTrans.textContent = row.translated;

      tr.appendChild(tdLine);
      tr.appendChild(tdFile);
      tr.appendChild(tdOrig);
      tr.appendChild(tdTrans);

      tr.addEventListener("click", () => {
        openLineEditor(row.line_num);
      });

      frag.appendChild(tr);
    }
    ui.proofreadTableBody.appendChild(frag);

    if (totalMatches > PROOFREAD_RENDER_LIMIT) {
      ui.proofreadStatus.textContent = `Ditemukan ${totalMatches} baris (ditampilkan ${PROOFREAD_RENDER_LIMIT} pertama).`;
    } else {
      ui.proofreadStatus.textContent = `Ditemukan ${totalMatches} baris.`;
    }
  }

  function onOpenSettings() {
    ui.settingsPromptInput.value = state.aiInstructionHeader;
    openModal(ui.settingsModal);
  }

  function onSavePromptSettings() {
    const value = ui.settingsPromptInput.value.trim();
    if (!value) {
      alert("Prompt tidak boleh kosong.");
      return;
    }
    state.aiInstructionHeader = value;
    closeModal(ui.settingsModal);
    autoSaveProject("prompt_settings");
    flashHint("Pengaturan prompt diperbarui.");
  }

  function buildSessionPayload() {
    return {
      version: 1,
      imported_files: state.importedFiles,
      name_table: state.nameTable,
      lines: state.lines,
      prompt_header: state.aiInstructionHeader,
      source_label: state.sourceLabel,
      last_copied_range: state.lastCopiedRange,
    };
  }

  function loadSessionPayload(payload) {
    if (!payload || typeof payload !== "object") {
      throw new Error("Payload session tidak valid.");
    }

    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    state.lines = lines.map(normalizeLineDict);

    const imported = Array.isArray(payload.imported_files) ? payload.imported_files : [];
    if (imported.length) {
      state.importedFiles = imported.map((x) => String(x));
    } else {
      state.importedFiles = [...new Set(state.lines.map((line) => line.file).filter(Boolean))];
    }

    state.nameTable = payload.name_table && typeof payload.name_table === "object"
      ? { ...payload.name_table }
      : {};
    state.aiInstructionHeader = (payload.prompt_header || "").trim() || DEFAULT_PROMPT_HEADER;
    state.sourceLabel = String(payload.source_label || "");
    const copiedRange = payload.last_copied_range;
    if (
      copiedRange &&
      Number.isInteger(copiedRange.from) &&
      Number.isInteger(copiedRange.to) &&
      copiedRange.from > 0 &&
      copiedRange.to > 0
    ) {
      state.lastCopiedRange = {
        from: copiedRange.from,
        to: copiedRange.to,
      };
    } else {
      state.lastCopiedRange = null;
    }
    state.selectedFrom = 1;
    state.selectedTo = Math.min(30, Math.max(state.lines.length, 1));
    ui.pasteArea.value = "";
    clearUndo();
    refreshAll();
  }

  function autoSaveProject(reason) {
    try {
      const wrapped = {
        savedAt: new Date().toISOString(),
        reason: reason || "autosave",
        payload: buildSessionPayload(),
      };
      localStorage.setItem(STORAGE_KEYS.autosave, JSON.stringify(wrapped));
      localStorage.setItem(STORAGE_KEYS.lastProject, JSON.stringify(wrapped));
    } catch (_err) {
      // ignore quota/storage errors
    }
  }

  function onSaveSession() {
    const payload = buildSessionPayload();
    const text = JSON.stringify(payload, null, 2);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadText(`vn_session_${stamp}.vntrans`, text, "application/json");
    autoSaveProject("manual_save");
    flashHint("Session tersimpan sebagai file.");
  }

  async function onLoadSessionChange(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      loadSessionPayload(payload);
      autoSaveProject("load_session");
      flashHint("Session berhasil dimuat.");
    } catch (err) {
      alert(`Gagal memuat session: ${err.message || err}`);
    }
  }

  function buildExportFiles() {
    const grouped = new Map();
    for (const line of state.lines) {
      if (!grouped.has(line.file)) grouped.set(line.file, []);
      grouped.get(line.file).push(line);
    }

    const out = [];
    for (const [fileName, lines] of grouped.entries()) {
      const arr = lines.map((line) => {
        const originalName = line.name;
        const originalMessage = line.message;
        const transName = (line.trans_name || "").trim() || null;
        const transMessage = (line.trans_message || "").trim() || null;
        const entry = {};

        if (isTranslated(line) && transMessage) {
          if (originalName) {
            const mappedName = (state.nameTable[originalName] || "").trim() || null;
            entry.name = transName || mappedName || originalName;
          }
          entry.message = transMessage;
        } else {
          if (originalName) {
            entry.name = originalName;
          }
          entry.message = originalMessage;
        }
        return entry;
      });
      out.push({
        fileName: `${fileName}.json`,
        content: JSON.stringify(arr, null, 2),
      });
    }
    return out;
  }

  async function onExport() {
    if (!state.lines.length) {
      alert("Belum ada data untuk diekspor.");
      return;
    }

    const exportFiles = buildExportFiles();
    if (!exportFiles.length) {
      alert("Tidak ada data untuk diekspor.");
      return;
    }

    if (window.JSZip) {
      const zip = new window.JSZip();
      for (const file of exportFiles) {
        zip.file(file.fileName, file.content);
      }
      const blob = await zip.generateAsync({ type: "blob" });
      downloadBlob("vn_export.zip", blob);
      flashHint(`Ekspor selesai: ${exportFiles.length} file dalam vn_export.zip`);
      return;
    }

    for (const file of exportFiles) {
      downloadText(file.fileName, file.content, "application/json");
    }
    flashHint(`Ekspor selesai: ${exportFiles.length} file diunduh.`);
  }

  function onStartupLastProject() {
    const wrapped = readStoredLastProject();
    if (!wrapped || !wrapped.payload) return;
    try {
      loadSessionPayload(wrapped.payload);
      closeModal(ui.startupModal);
      flashHint("Proyek terakhir dimuat.");
    } catch (err) {
      alert(`Proyek terakhir gagal dimuat: ${err.message || err}`);
    }
  }

  function readStoredLastProject() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.lastProject);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      return parsed;
    } catch (_err) {
      return null;
    }
  }

  function showStartupModal() {
    const wrapped = readStoredLastProject();
    if (!wrapped || !wrapped.payload) {
      ui.btnStartupLast.disabled = true;
      ui.startupInfo.textContent = "Belum ada proyek terakhir tersimpan di browser ini.";
    } else {
      ui.btnStartupLast.disabled = false;
      const when = wrapped.savedAt ? ` (${new Date(wrapped.savedAt).toLocaleString()})` : "";
      ui.startupInfo.textContent = `Proyek terakhir terdeteksi${when}.`;
    }
    openModal(ui.startupModal);
  }

  function openModal(modalEl) {
    modalEl.classList.add("open");
  }

  function closeModal(modalEl) {
    modalEl.classList.remove("open");
  }

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function downloadText(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType || "text/plain;charset=utf-8" });
    downloadBlob(filename, blob);
  }
})();
