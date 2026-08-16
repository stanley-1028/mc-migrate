const $ = (id) => document.getElementById(id);
let summary = null;
let pickedFiles = [];
let savedModel = '';
let modelTimer = null;

function renderFiles() {
  const list = $('fileList');
  list.hidden = pickedFiles.length === 0;
  list.innerHTML = '';
  for (const f of pickedFiles) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    const p = document.createElement('span');
    p.className = 'path';
    p.textContent = f;
    p.title = f;
    const x = document.createElement('button');
    x.textContent = '×';
    x.onclick = () => {
      pickedFiles = pickedFiles.filter((v) => v !== f);
      renderFiles();
      updateProjectChip();
    };
    chip.append(p, x);
    list.appendChild(chip);
  }
}

function updateProjectChip() {
  const chip = $('projChip');
  if (pickedFiles.length) {
    chip.textContent = `${pickedFiles.length} 個 Java 文件`;
    chip.title = pickedFiles.join('\n');
  } else {
    chip.textContent = '未選擇文件';
    chip.title = '';
  }
}

function logLine(type, text) {
  const div = document.createElement('div');
  if (type === 'warn') div.className = 'warn';
  if (type === 'error') div.className = 'error';
  div.textContent = text;
  $('log').appendChild(div);
  $('log').scrollTop = $('log').scrollHeight;
}

function setStatus(mode, text) {
  $('status').className = 'status-chip' + (mode ? ' ' + mode : '');
  $('status-text').textContent = text;
}

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = false;
}

function hideError() {
  $('error').hidden = true;
}

function resetSteps() {
  for (let i = 1; i <= 5; i++) {
    const el = document.querySelector(`.step[data-step="${i}"]`);
    el.className = 'step';
    el.querySelector('.n').textContent = String(i);
    const line = document.querySelector(`.line[data-line="${i}"]`);
    if (line) line.classList.remove('done');
  }
}

function setStep(i, status) {
  const el = document.querySelector(`.step[data-step="${i}"]`);
  if (!el) return;
  el.className = 'step' + (status ? ' ' + status : '');
  if (status === 'done') el.querySelector('.n').textContent = '✓';
  const line = document.querySelector(`.line[data-line="${i}"]`);
  if (line) line.classList.toggle('done', status === 'done');
}

function failActiveStep() {
  const active = document.querySelector('.step.active');
  if (active) active.className = 'step failed';
}

function buildSummary(summary) {
  const strip = $('summaryStrip');
  strip.innerHTML = '';
  strip.hidden = false;
  const chip = (text, cls) => {
    const d = document.createElement('span');
    d.className = 'chip-sum' + (cls ? ' ' + cls : '');
    d.textContent = text;
    strip.appendChild(d);
  };
  chip(`變更 ${summary.changed} 檔`);
  if (summary.reviewCount) chip(`需人工確認 ${summary.reviewCount} 項`, 'warn');
  chip(`迭代 ${summary.iterations} 次`);
  const buildText = summary.buildStatus === 'ok' ? '通過' : summary.buildStatus === 'skip' ? '跳過' : '失敗';
  chip(`建構驗證：${buildText}`, summary.buildFailed ? 'bad' : '');
}

// 輸入 API Key 後向供應商拉取可用模型清單
async function loadModels() {
  const provider = $('provider').value;
  const key = $('apiKey').value.trim();
  const sel = $('model');
  const hint = $('modelHint');
  sel.innerHTML = '<option value="">自動（供應商預設）</option>';
  if (!key || provider === 'mock') {
    hint.hidden = true;
    return;
  }
  hint.hidden = false;
  hint.textContent = '載入模型清單…';
  try {
    const r = await window.api.listModels(provider, key);
    if (!r.ok) {
      hint.textContent = `無法取得模型清單（${r.error}），可留空使用預設`;
      return;
    }
    for (const m of r.models) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = m;
      sel.appendChild(o);
    }
    hint.textContent = `已載入 ${r.models.length} 個可用模型`;
    if (savedModel && [...sel.options].some((o) => o.value === savedModel)) {
      sel.value = savedModel;
    }
  } catch {
    hint.textContent = '無法取得模型清單，可留空使用預設';
  }
}

function collectParams() {
  return {
    files: pickedFiles.length ? pickedFiles : null,
    target: $('target').value.trim() || '26.2',
    env: $('env').value.trim() || null,
    provider: $('provider').value,
    model: $('model').value,
    apiKey: $('apiKey').value,
    maxIterations: parseInt($('maxIterations').value, 10) || 5,
    buildCmd: $('buildCmd').value.trim(),
    noBuild: $('noBuild').checked,
    dryRun: $('dryRun').checked,
    force: $('force').checked,
  };
}

async function init() {
  const s = await window.api.loadSettings();
  if (s.target) $('target').value = s.target;
  if (s.provider) $('provider').value = s.provider;
  savedModel = s.model || '';
  if (s.apiKey) $('apiKey').value = s.apiKey;
  if (s.maxIterations) $('maxIterations').value = s.maxIterations;
  if (s.buildCmd) $('buildCmd').value = s.buildCmd;
  $('noBuild').checked = !!s.noBuild;
  $('dryRun').checked = !!s.dryRun;
  $('force').checked = !!s.force;
  updateProjectChip();
  if (s.apiKey) loadModels();
  const ver = await window.api.getVersion();
  $('footerText').textContent = `MC-Migrate v${ver} · API Key 僅存本機、不隨專案提交 · 遷移前請確認 git 狀態`;
}

// 進度監聽最先註冊（不放在 init 的 await 之後，避免遺失早期事件）
window.api.onProgress(({ type, text }) => {
  if (type === 'step') setStep(text.step, text.status);
  else logLine(type, text);
});

$('dropZone').onclick = async () => {
  const files = await window.api.pickFiles();
  if (files && files.length) {
    for (const f of files) {
      if (!pickedFiles.includes(f)) pickedFiles.push(f);
    }
    renderFiles();
    updateProjectChip();
  }
};

$('apiKey').addEventListener('input', () => {
  clearTimeout(modelTimer);
  modelTimer = setTimeout(loadModels, 600);
});

$('provider').addEventListener('change', () => {
  if ($('apiKey').value.trim()) loadModels();
});

$('clear').onclick = () => {
  $('log').innerHTML = '';
  $('clear').disabled = true;
};

$('run').onclick = async () => {
  const params = collectParams();
  if (!(params.files && params.files.length)) {
    showError('請先加入 Java 文件');
    return;
  }
  if (params.provider !== 'mock' && !params.apiKey) {
    showError('此供應商需要 API Key（僅存本機）。沒有 Key 可先選「Mock（離線演示）」。');
    return;
  }
  hideError();
  summary = null;
  $('log').innerHTML = '';
  $('actions').hidden = true;
  $('saveReport').hidden = true;
  $('savePatch').hidden = true;
  $('summaryStrip').hidden = true;
  $('summaryStrip').innerHTML = '';
  $('run').disabled = true;
  $('cancel').hidden = false;
  $('clear').disabled = false;
  resetSteps();
  setStep(1, 'active');
  setStatus('running', '執行中…');
  await window.api.saveSettings(params);
  try {
    const r = await window.api.run(params);
    if (!r.ok) {
      failActiveStep();
      if (r.cancelled) {
        setStatus('', '已取消');
        logLine('warn', '已取消：已完成的檔案有備份與狀態記錄，再次執行會接續。');
      } else {
        showError(r.error);
        setStatus('failed', '失敗');
      }
    } else {
      summary = r.summary;
      if (summary.dryRun) {
        setStatus('', '預覽完成');
      } else if (summary.buildFailed) {
        setStatus('running', '完成（建構未通過）');
      } else {
        setStatus('', '完成');
      }
      if (!summary.dryRun) {
        buildSummary(summary);
        $('actions').hidden = false;
        $('saveReport').hidden = false;
        $('savePatch').hidden = false;
      }
    }
  } finally {
    $('run').disabled = false;
    $('cancel').hidden = true;
  }
};

$('cancel').onclick = async () => {
  logLine('warn', '送出取消請求…（等待目前這一段完成）');
  await window.api.cancel();
};

const shownPcts = new Set();
window.api.onUpdateProgress(({ pct }) => {
  if (!shownPcts.has(pct)) {
    shownPcts.add(pct);
    logLine('log', `下載中：${pct}%`);
  }
});

$('checkUpdate').onclick = async () => {
  $('checkUpdate').disabled = true;
  setStatus('running', '檢查更新…');
  try {
    const r = await window.api.updateCheck();
    if (!r.ok) {
      logLine('warn', `檢查更新失敗：${r.error}`);
      setStatus('', '待命');
      return;
    }
    if (!r.hasUpdate) {
      logLine('log', `已是最新版本 v${r.current}`);
      setStatus('', '待命');
      return;
    }
    const yes = confirm(
      `發現新版 v${r.latest}（目前 v${r.current}，約 ${Math.round((r.size || 0) / 1048576)} MB）。\n要下載並自動更新嗎？`
    );
    if (!yes) {
      setStatus('', '待命');
      return;
    }
    $('run').disabled = true;
    shownPcts.clear();
    logLine('log', `開始下載 v${r.latest}…`);
    const inst = await window.api.updateInstall(r.url);
    if (!inst.ok) {
      logLine('warn', `更新失敗：${inst.error}`);
      setStatus('', '待命');
      $('run').disabled = false;
      return;
    }
    logLine('log', '更新已套用，正在重新啟動…');
  } finally {
    $('checkUpdate').disabled = false;
  }
};

$('openDir').onclick = () => {
  if (summary) window.api.openFolder(summary.project);
};

$('saveReport').onclick = async () => {
  if (!summary) return;
  const p = await window.api.saveArtifact('report', summary.reportPath);
  if (p) logLine('log', `已另存報告：${p}`);
};

$('savePatch').onclick = async () => {
  if (!summary) return;
  const p = await window.api.saveArtifact('patch', summary.patchPath);
  if (p) logLine('log', `已另存補丁：${p}`);
};

init();
