const $ = (id) => document.getElementById(id);
let summary = null;
let pickedFiles = [];

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
    };
    chip.append(p, x);
    list.appendChild(chip);
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

function collectParams() {
  return {
    project: $('project').value.trim(),
    files: pickedFiles.length ? pickedFiles : null,
    target: $('target').value.trim() || '26.2',
    env: $('env').value.trim() || null,
    provider: $('provider').value,
    model: $('model').value.trim(),
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
  if (s.project) $('project').value = s.project;
  if (s.target) $('target').value = s.target;
  if (s.provider) $('provider').value = s.provider;
  if (s.model) $('model').value = s.model;
  if (s.apiKey) $('apiKey').value = s.apiKey;
  if (s.maxIterations) $('maxIterations').value = s.maxIterations;
  if (s.buildCmd) $('buildCmd').value = s.buildCmd;
  $('noBuild').checked = !!s.noBuild;
  $('dryRun').checked = !!s.dryRun;
  $('force').checked = !!s.force;
  window.api.onProgress(({ type, text }) => logLine(type, text));
}

$('pick').onclick = async () => {
  const p = await window.api.pickFolder();
  if (p) $('project').value = p;
};

$('pickFiles').onclick = async () => {
  const files = await window.api.pickFiles();
  if (files && files.length) {
    for (const f of files) {
      if (!pickedFiles.includes(f)) pickedFiles.push(f);
    }
    renderFiles();
  }
};

$('clear').onclick = () => {
  $('log').innerHTML = '';
  $('clear').disabled = true;
};

$('run').onclick = async () => {
  const params = collectParams();
  if (!params.project && !(params.files && params.files.length)) {
    showError('請選擇模組專案資料夾，或加入 Java 文件');
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
  $('run').disabled = true;
  $('clear').disabled = false;
  setStatus('running', '執行中…');
  await window.api.saveSettings(params);
  try {
    const r = await window.api.run(params);
    if (!r.ok) {
      showError(r.error);
      setStatus('failed', '失敗');
    } else {
      summary = r.summary;
      if (summary.dryRun) {
        setStatus('', '預覽完成');
      } else if (summary.buildFailed) {
        setStatus('running', '完成（建構未通過）');
      } else {
        setStatus('', '完成');
      }
      $('actions').hidden = false;
      if (!summary.dryRun) {
        $('saveReport').hidden = false;
        $('savePatch').hidden = false;
      }
    }
  } finally {
    $('run').disabled = false;
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
