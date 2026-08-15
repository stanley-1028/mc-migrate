const $ = (id) => document.getElementById(id);
let summary = null;

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
    fromVer: $('fromVer').value.trim() || '1.20.1',
    target: $('target').value.trim() || '26.3',
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
  if (s.fromVer) $('fromVer').value = s.fromVer;
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

$('clear').onclick = () => {
  $('log').innerHTML = '';
  $('clear').disabled = true;
};

$('run').onclick = async () => {
  const params = collectParams();
  if (!params.project) {
    showError('請先選擇模組專案路徑');
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
