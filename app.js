import { api, exportDocument, previewPage, removeDocument } from "./browser-api.js";
const $ = selector => document.querySelector(selector);
const state = {
  tasks: [], selected: new Set(), documents: [], edits: {}, roles: {}, selection: {}, reviews: {},
  config: {}, token: '', serverModel: false, result: null, prompt: '', comparison: null,
  resultBody: {}, reasonEdits: {}, tab: 'result', busy: false, inspecting: null, sourceEdits: {},
  providers: [], draftProvider: 'custom', checkedModel: null
};

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function message(text, type = '') {
  const box = $('#message'); box.hidden = false; box.className = 'message ' + type; box.textContent = text;
}
function busy(on, text = '') {
  state.busy = on;
  for (const id of ['run', 'auto-run', 'prepare', 'external-compare']) $('#' + id).disabled = on;
  if (text) message(text, 'busy');
}
function profile() {
  const field = $('#field').value.trim(), research_direction = $('#direction').value.trim();
  if (!field) { $('#field').reportValidity(); throw Error('请先填写研究领域。'); }
  if (!research_direction) { $('#direction').reportValidity(); throw Error('请先填写具体研究方向。'); }
  return { field, research_direction, target_venue: $('#venue').value.trim() || null };
}
function materials() {
  return { text: $('#manuscript').value, document_ids: state.documents.map(d => d.id),
    document_edits: state.edits, document_roles: state.roles, document_selection: state.selection, document_reviews: state.reviews };
}
function payload(auto = false) {
  const body = { ...materials(), profile: profile(), task_ids: [...state.selected].sort(), auto };
  if (!body.text.trim() && !body.document_ids.length) throw Error('请粘贴内容或上传文件。');
  if (!auto && !body.task_ids.length) throw Error('请选择一项或多项功能，或使用“自动处理”。');
  return body;
}
function snapshot(body) { return JSON.parse(JSON.stringify(body)); }
function modelAvailable() { return state.serverModel || (state.config.endpoint && state.config.model); }

function draftModel() {
  return { endpoint: $('#endpoint').value.trim(), model: $('#model-name').value.trim(), api_key: $('#api-key').value,
    protocol: $('#model-protocol').value, provider: $('#model-provider').value || 'custom', free_only: $('#free-only').checked };
}
function modelFingerprint(config) { return JSON.stringify(config); }
function modelStatus(text, error = false) {
  const box = $('#model-status'); box.textContent = text; box.classList.toggle('error', error);
}
function modelChanged() { state.checkedModel = null; modelStatus('配置已更改，尚未验证当前连接。'); }
function providerById(id) { return state.providers.find(provider => provider.id === id); }
function fillModelOptions(models, live = false) {
  const select = $('#model-preset'), typed = $('#model-name').value;
  select.replaceChildren(new Option('手动填写模型ID', ''));
  for (const model of models) {
    if ($('#free-only').checked && !live && model.cost !== 'free_api') continue;
    const label = live ? model.id + (model.free_candidate ? ' · 免费候选' : ' · 费用以服务为准') : model.label;
    select.add(new Option(label, model.id));
  }
  if ([...select.options].some(option => option.value === typed)) select.value = typed;
}
function applyProvider(id, reset = true) {
  const provider = providerById(id); if (!provider) return;
  if (reset) {
    $('#api-key').value = ''; $('#endpoint').value = provider.endpoint; $('#model-protocol').value = provider.protocol;
    const first = provider.models.find(model => !$('#free-only').checked || model.cost === 'free_api');
    $('#model-name').value = first?.id || ''; modelChanged();
  }
  state.draftProvider = id; $('#provider-note').textContent = provider.cost_note;
  $('#key-requirement').textContent = provider.key_required ? '云端模型需要自己的密钥' : '本地服务可留空；已启用认证时填写令牌';
  $('#model-name').placeholder = provider.group === 'local' ? '先读取本机已下载或已加载的模型，也可手动填写' : provider.id === 'doubao' ? '填写控制台的模型ID或推理接入点ID' : '选择候选模型，或填写账户可用模型ID';
  const links = $('#provider-links'); links.replaceChildren();
  provider.sources.forEach((url, index) => { const link = el('a', index ? '官方说明 ' + (index + 1) : '查看官方接入说明'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; links.append(link); });
  fillModelOptions(provider.models); $('#model-advanced').open = id === 'custom';
  if (reset) modelStatus(provider.group === 'local' ? '先启动本地模型服务，再点击“读取服务可用模型”。' : '预设已填写，尚未连接。请使用该服务自己的API Key。');
}
function renderProviders() {
  const select = $('#model-provider'), selected = select.value || state.draftProvider;
  select.replaceChildren();
  const groups = { local: '本地免费运行', free_cloud: '含免费型号的云服务', domestic: '国产云模型', custom: '自定义与其他接口' };
  for (const [group, label] of Object.entries(groups)) {
    const available = state.providers.filter(provider => provider.group === group && (!$('#free-only').checked || group === 'local' || provider.models.some(model => model.cost === 'free_api')));
    if (!available.length) continue;
    const section = el('optgroup'); section.label = label;
    for (const provider of available) section.append(new Option(provider.name, provider.id)); select.append(section);
  }
  const preserve = [...select.options].some(option => option.value === selected);
  if (preserve) select.value = selected;
  applyProvider(select.value, !preserve);
}
async function loadProviders() {
  const data = await api('/api/providers'); state.providers = data.providers; renderProviders();
}
async function modelDiagnostic(test = false) {
  const buttons = [$('#models-refresh'), $('#model-test')]; buttons.forEach(button => { button.disabled = true; });
  try {
    state.token = $('#service-token').value;
    const config = draftModel(); modelStatus(test ? '正在发送固定短句测试连接，不会提交论文内容……' : '正在读取服务返回的模型列表……');
    const result = await api(test ? '/api/models/test' : '/api/models/list', { config });
    if (test) {
      state.checkedModel = result.status === 'connected' ? { fingerprint: modelFingerprint(config), reported: result.reported_model } : null;
      modelStatus(result.status === 'connected' ? '连接已验证 · 实际返回模型：' + result.reported_model + ' · ' + result.latency_ms + ' ms' : '模型有响应，但测试输出未完成；未标记为验证通过。');
    } else {
      fillModelOptions(result.models, true);
      modelStatus(result.models.length ? '已读取 ' + result.models.length + ' 个可选模型。请选择后测试连接。' : '当前筛选下没有可用模型。可检查免费配额、本地模型是否加载，或关闭免费筛选后查看。');
    }
  } catch (error) { state.checkedModel = null; modelStatus(error.message, true); }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}

function updateSelection() {
  const count = state.selected.size;
  $('#selection-count').textContent = count ? '已选 ' + count + ' 项 · ' + [...state.selected].sort().join(' / ') : '尚未选择功能';
  document.querySelectorAll('.tool').forEach(node => node.classList.toggle('selected', state.selected.has(node.dataset.id)));
}
function renderTasks() {
  const wrap = $('#tool-groups'); wrap.replaceChildren();
  for (const [title, from, to] of [['翻译与草稿重构', 1, 4], ['表达、长度与逻辑', 5, 11], ['图表与研究分析', 12, 17]]) {
    wrap.append(el('div', title, 'group-title'));
    const grid = el('div', undefined, 'tool-grid');
    for (const task of state.tasks.filter(t => +t.id >= from && +t.id <= to)) {
      const label = el('label', undefined, 'tool'); label.dataset.id = task.id;
      const input = el('input'); input.type = 'checkbox'; input.value = task.id;
      input.setAttribute('aria-label', task.id + ' ' + task.title);
      input.onchange = () => { input.checked ? state.selected.add(task.id) : state.selected.delete(task.id); updateSelection(); };
      label.append(el('span', task.id, 'tool-number'), el('span', task.title, 'tool-name'), input); grid.append(label);
    }
    wrap.append(grid);
  }
  updateSelection();
}
function renderDocuments() {
  const box = $('#documents'); box.replaceChildren();
  for (const doc of state.documents) {
    const row = el('div', undefined, 'document-row'), info = el('div', undefined, 'document-info');
    const selected = state.selection[doc.id] || [];
    info.append(el('b', doc.filename), el('small', (doc.page_count ? doc.page_count + '页 · ' : '') + selected.length + '/' + doc.blocks.length + '块已选'));
    const role = el('select'); role.setAttribute('aria-label', doc.filename + '材料角色');
    for (const [value, label] of Object.entries({ manuscript: '待处理稿', data: '数据材料', reference: '参考资料', guidelines: '投稿规范' })) role.add(new Option(label, value));
    role.value = state.roles[doc.id] || 'manuscript'; role.onchange = () => { state.roles[doc.id] = role.value; renderScope(); };
    const preview = el('button', '查看识别', 'text-button'); preview.onclick = () => inspect(doc);
    const remove = el('button', '×', 'remove'); remove.setAttribute('aria-label', '移除' + doc.filename);
    remove.onclick = () => { state.documents = state.documents.filter(d => d.id !== doc.id);
      removeDocument(doc.id); renderDocuments(); };
    row.append(info, role, preview, remove); box.append(row);
  }
  renderScope();
}
async function readFile(file) {
  if (file.size > 30 * 1024 * 1024) throw Error('单文件大小上限为 30 MB。');
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file);
  });
}
async function upload(files) {
  if (state.busy) return;
  busy(true, '正在读取文件与结构；扫描PDF首次识别可能需要一些时间。');
  try {
    for (const file of files) {
      const doc = await api('/api/documents', { filename: file.name, content_base64: await readFile(file), force_ocr: $('#force-ocr').checked });
      state.documents.push(doc); state.roles[doc.id] = 'manuscript'; state.edits[doc.id] = {}; state.reviews[doc.id] = {};
      state.selection[doc.id] = doc.blocks.map(block => block.id); renderDocuments();
    }
    message('材料已读取。可以选择处理范围，并核对公式、表格与疑难文字。');
  } catch (error) { message(error.message, 'error'); }
  finally { busy(false); $('#file-input').value = ''; }
}
function inspect(doc) {
  state.inspecting = doc; $('#document-title').textContent = doc.filename; $('#document-warnings').textContent = doc.warnings.join(' ');
  const select = $('#page-select'); select.replaceChildren();
  for (let page = 1; page <= (doc.page_count || 1); page++) select.add(new Option(doc.page_count ? '第 ' + page + ' 页' : '全部段落', page));
  select.value = '1'; $('#document-dialog').showModal(); renderBlocks();
}
async function renderBlocks() {
  const doc = state.inspecting, page = +$('#page-select').value;
  $('#page-image-wrap').hidden = !doc.page_count;
  if (doc.page_count) {
    try {
      const image = await previewPage(doc.id, page);
      if (state.inspecting !== doc || +$('#page-select').value !== page || !$('#document-dialog').open) return;
      const old = $('#page-image').src; $('#page-image').src = URL.createObjectURL(image);
      if (old.startsWith('blob:')) URL.revokeObjectURL(old);
    } catch (error) { message(error.message, 'error'); }
  }
  if (state.inspecting !== doc || +$('#page-select').value !== page) return;
  const wrap = $('#blocks'); wrap.replaceChildren();
  for (const block of doc.blocks.filter(b => !doc.page_count || b.page === page)) {
    const item = el('div', undefined, 'block ' + block.kind);
    item.append(el('div', block.id + ' · ' + block.location + (block.numbering ? ' · 自动编号 ' + block.numbering : '') + (block.math?.length ? ' · 含公式对象' : ''), 'block-label'));
    const includeLabel = el('label', undefined, 'block-option'), include = el('input');
    include.type = 'checkbox'; include.className = 'include-block'; include.checked = state.selection[doc.id].includes(block.id);
    include.setAttribute('aria-label', block.id + '纳入处理');
    include.onchange = () => { const ids = new Set(state.selection[doc.id]); include.checked ? ids.add(block.id) : ids.delete(block.id); state.selection[doc.id] = [...ids]; renderDocuments(); };
    includeLabel.append(include, document.createTextNode(' 纳入本次处理')); item.append(includeLabel);
    if (block.rows) {
      const table = el('table');
      for (const row of block.rows) { const tr = el('tr'); for (const value of row) tr.append(el('td', value)); table.append(tr); }
      item.append(table);
    }
    const area = el('textarea'); area.value = state.edits[doc.id][block.id] ?? block.text;
    area.rows = Math.min(10, Math.max(2, area.value.split('\n').length + 1)); area.setAttribute('aria-label', block.id + '识别文字');
    area.oninput = () => {
      state.edits[doc.id][block.id] = area.value;
      if (state.reviews[doc.id][block.id]) state.reviews[doc.id][block.id] = { status: 'needs_review', note: '识别文字已更改，请重新核对' };
      const verification = item.querySelector('.verify-block'); if (verification) verification.checked = false;
      renderScope();
    }; item.append(area);
    if (block.math?.length || block.kind === 'table' || block.review || block.method === 'browser_ocr') {
      const label = el('label', undefined, 'block-option'), verify = el('input'); verify.type = 'checkbox'; verify.className = 'verify-block';
      verify.checked = state.reviews[doc.id][block.id]?.status === 'verified'; verify.setAttribute('aria-label', block.id + '已核对原稿');
      verify.onchange = () => { state.reviews[doc.id][block.id] = { status: verify.checked ? 'verified' : 'needs_review', note: '使用者在识别预览中记录', reviewed_text: area.value }; renderScope(); };
      label.append(verify, document.createTextNode(' 我已对照原稿核对此处（人工记录）')); item.append(label);
    }
    if (block.math?.length) {
      const details = el('details'); details.append(el('summary', '查看原始公式对象'));
      details.append(el('pre', block.math.map(math => math.raw_xml).join('\n'))); item.append(details);
    }
    wrap.append(item);
  }
}
function renderScope() {
  const box = $('#scope-view'); box.replaceChildren();
  if (state.result) {
    box.append(el('h3', '最近结果实际使用的范围', 'scope-title'));
    const snapshotIds = state.resultBody.document_ids || [];
    if (state.resultBody.text?.trim()) box.append(el('p', '已处理的粘贴原稿：' + state.resultBody.text.length + ' 字符', 'muted'));
    for (const id of snapshotIds) {
      const doc = state.documents.find(item => item.id === id);
      const role = state.resultBody.document_roles?.[id] || 'manuscript';
      const names = { manuscript: '待处理稿', reference: '参考资料', data: '数据材料', guidelines: '投稿规范' };
      box.append(el('div', (doc?.filename || id) + ' · ' + (names[role] || role) + ' · ' + (state.resultBody.document_selection?.[id]?.length ?? doc?.blocks.length ?? '?') + '块', 'scope-row'));
    }
    box.append(el('h3', '当前待处理输入', 'scope-title'));
  }
  if (!state.documents.length) box.append(el('p', '当前使用直接粘贴内容；比较时按粘贴段落定位。', 'muted'));
  for (const doc of state.documents) {
    const candidates = doc.blocks.filter(b => b.math?.length || b.kind === 'table' || b.review || b.method === 'vision_ocr');
    const unresolved = candidates.filter(b => state.reviews[doc.id]?.[b.id]?.status !== 'verified').length;
    box.append(el('div', doc.filename + ' · ' + state.selection[doc.id].length + '/' + doc.blocks.length + '块已选 · ' + unresolved + '处待人工核对', 'scope-row'));
    for (const warning of doc.warnings) box.append(el('p', warning, 'warning-item'));
  }
}
function tab(name) {
  state.tab = name; document.querySelectorAll('.tab').forEach(button => button.classList.toggle('active', button.dataset.tab === name));
  for (const value of ['result', 'comparison', 'prompt', 'scope']) $('#' + value + '-view').hidden = value !== name;
  $('#copy').disabled = name === 'scope' || (name === 'prompt' ? !state.prompt : !state.result);
  $('#download').disabled = $('#copy').disabled; $('#export-format').hidden = name === 'prompt';
}
function renderComparison(comparison) {
  if (state.comparison?.original !== comparison.original || state.comparison?.revised !== comparison.revised) state.sourceEdits = {};
  state.comparison = comparison; state.reasonEdits = {};
  const box = $('#comparison-view'); box.replaceChildren();
  const count = comparison.stats;
  box.append(el('p', '对照基准：最初原文 → 当前终稿 · ' + count.modified + '处改写 / ' + count.inserted + '处新增 / ' + count.deleted + '处删除 · ' + count.flagged_rows + '处需重点核对', 'comparison-summary'));
  box.append(el('p', '自动说明只描述文字变化。可填写作者说明，或让已配置的模型补充中文解释；说明来源会随导出保留。', 'muted'));
  const controls = el('div', undefined, 'comparison-controls');
  const save = el('button', '保存作者说明', 'quiet'); save.id = 'save-explanations'; save.onclick = saveExplanations;
  const ai = el('button', 'AI补充逐句说明', 'quiet'); ai.id = 'explain-changes'; ai.onclick = explainChanges;
  const showAllLabel = el('label', undefined, 'block-option'), showAll = el('input'); showAll.type = 'checkbox'; showAll.id = 'show-unchanged';
  showAllLabel.append(showAll, document.createTextNode(' 显示未改动句子'));
  controls.append(save, ai, showAllLabel); box.append(controls);
  const tableWrap = el('div', undefined, 'comparison-table-wrap'), table = el('table', undefined, 'comparison-table');
  const head = el('thead'), heading = el('tr');
  for (const title of ['原句与来源', '最终句', '中文说明与待核对项']) heading.append(el('th', title)); head.append(heading); table.append(head);
  const body = el('tbody');
  for (const row of comparison.rows) {
    const tr = el('tr', undefined, 'comparison-row ' + row.change_type); tr.dataset.id = row.id; tr.hidden = row.change_type === 'unchanged';
    const original = el('td'), revised = el('td'), reason = el('td');
    const changeLabel = { modified: '改写', inserted: '新增', deleted: '删除', unchanged: '未改动' };
    original.append(el('small', row.id + ' · ' + changeLabel[row.change_type], 'muted'), el('p', row.original || '（新增）'));
    for (const source of row.sources || []) {
      const button = el('button', [source.filename, source.location, source.block_id].filter(Boolean).join(' · '), 'source-link');
      button.onclick = () => { const doc = state.documents.find(d => d.id === source.document_id); if (doc) { inspect(doc); if (source.page) { $('#page-select').value = source.page; renderBlocks(); } } };
      original.append(button);
    }
    revised.append(el('p', row.revised || '（删除）'));
    const area = el('textarea', undefined, 'reason-edit'); area.value = row.explanation; area.setAttribute('aria-label', row.id + '修改说明');
    area.oninput = () => { state.reasonEdits[row.id] = { text: area.value, source: 'user' }; };
    const reasonSource = { deterministic_diff: '自动差异说明', supplied_user: '作者填写', supplied_model: '模型生成，需核对', supplied_unspecified: '导入说明，来源未注明' };
    reason.append(area, el('small', '来源：' + (reasonSource[row.explanation_source] || '外部提供的说明'), 'explanation-source'));
    for (const flag of row.review_flags || []) reason.append(el('p', flag.message, 'review-flag'));
    tr.append(original, revised, reason); body.append(tr);
  }
  table.append(body); tableWrap.append(table); box.append(tableWrap);
  showAll.onchange = () => body.querySelectorAll('.unchanged').forEach(row => { row.hidden = !showAll.checked; });
}
function explanationPayload() {
  const explanations = {};
  for (const row of state.comparison?.rows || []) {
    if (row.explanation_source !== 'deterministic_diff') explanations[row.id] = { text: row.explanation, source: row.explanation_source.replace(/^supplied_/, '') };
  }
  return { ...explanations, ...state.reasonEdits };
}
function comparisonPayload() {
  if (!state.comparison) throw Error('请先完成处理或导入最终稿。');
  return { ...state.resultBody, original: state.comparison.original, revised: state.comparison.revised, explanations: explanationPayload() };
}
async function saveExplanations() {
  try { renderComparison(await api('/api/compare', comparisonPayload())); message('作者说明已保存在当前对照中，导出时保留来源。'); }
  catch (error) { message(error.message, 'error'); }
}
async function explainChanges() {
  try {
    if (!modelAvailable()) { $('#model-dialog').showModal(); throw Error('补充说明需要模型配置；现有正文和对照已保留。'); }
    busy(true, '正在根据原句与终稿补充中文解释；不会改动正文。');
    renderComparison(await api('/api/explain', { ...comparisonPayload(), profile: profile(), config: state.config }));
    message('模型说明已返回，请核对解释依据及需作者重点核对的变化。');
  } catch (error) { message(error.message, 'error'); } finally { busy(false); }
}
function renderResult(result) {
  state.result = result; const wrap = $('#result-view'); wrap.replaceChildren();
  wrap.append(el('div', result.status === 'external_draft' ? '终稿来源：使用者导入；工作台未执行此次AI改写。' : '执行计划：' + (result.plan.task_ids.join(' → ') || '无需改写') + ' · ' + result.plan.reason, 'plan-note'));
  const final = el('section', undefined, 'final-draft'); final.append(el('h3', '当前最终正文'), el('pre', result.final_text || '（尚无可用终稿）')); wrap.append(final);
  for (const step of result.steps || []) {
    const section = el('details', undefined, 'step-output'); section.append(el('summary', step.task_id + ' / ' + step.title));
    section.append(el('pre', step.output));
    if (step.warning) section.append(el('p', step.warning, 'warning-item'));
    if (step.svg) { const image = el('img'); image.src = URL.createObjectURL(new Blob([step.svg], { type: 'image/svg+xml' })); image.alt = '模型生成的研究示意图，需核对内容'; const figure = el('div', undefined, 'generated-svg'); figure.append(image); section.append(figure); }
    wrap.append(section);
  }
  if (result.error) wrap.append(el('p', result.error, 'warning-item'));
  $('#result-state').textContent = result.status === 'completed' ? '处理完成' : result.status === 'external_draft' ? '已导入终稿 · 可核对与导出' : '处理未完整完成，已有成果保留';
  if (result.comparison) renderComparison(result.comparison); tab('result');
  renderScope();
}
async function act(mode) {
  try {
    const body = payload(mode === 'auto'); busy(true, mode === 'prepare' ? '正在绑定领域与所选材料。' : '正在按实际功能处理材料；请等待模型返回。');
    const prepared = await api('/api/prepare', body); state.prompt = prepared.prompt; $('#prompt-view').textContent = state.prompt;
    if (mode === 'prepare') { $('#result-state').textContent = '提示词已就绪 · 尚未调用AI'; tab('prompt'); message('已绑定领域、方向及所选材料。可复制到现有AI，或配置模型后直接处理。'); }
    else {
      if (!modelAvailable()) { $('#model-dialog').showModal(); throw Error('提示词已准备好，请配置模型后运行；尚未调用AI。'); }
      const result = await api('/api/run', { ...body, config: state.config }); state.resultBody = snapshot(body); renderResult(result);
      message(result.status === 'completed' ? '结果已返回，可查看累计修改对照并导出。' : result.error || '处理未完整完成，请查看已保留的步骤。', result.status === 'completed' ? '' : 'error');
    }
  } catch (error) { message(error.message, 'error'); } finally { busy(false); }
}
function save(data, name, type = 'text/markdown;charset=utf-8') {
  const link = el('a'); link.href = URL.createObjectURL(new Blob([data], { type })); link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}
async function download(body) {
  const file = await exportDocument(body);
  if (file) save(file.data, file.name, file.type);
}
function exportText() {
  if (state.tab === 'prompt') return state.prompt;
  if (state.tab === 'comparison') return state.comparison?.rows.map(row => row.id + '\n原句：' + row.original + '\n终稿：' + row.revised + '\n说明：' + (state.reasonEdits[row.id]?.text || row.explanation)).join('\n\n') || '';
  return state.result?.final_text || '';
}
async function exportFile() {
  try {
    if (state.tab === 'prompt') return save(state.prompt, '科研写作执行提示词.md');
    const format = $('#export-format').value;
    if (format === 'json') {
      const comparison = { ...state.comparison, rows: state.comparison.rows.map(row => state.reasonEdits[row.id] ? { ...row, explanation: state.reasonEdits[row.id].text, explanation_source: 'supplied_user' } : row) };
      return save(JSON.stringify({ ...state.result, comparison, source_scope: state.resultBody }, null, 2), '科研写作处理记录.json', 'application/json');
    }
    if (format === 'print') { tab('comparison'); window.print(); return; }
    busy(true, '正在生成导出文件。'); await download({ ...comparisonPayload(), format }); message('文件已生成并下载。');
  } catch (error) { message(error.message, 'error'); } finally { busy(false); }
}
$('#manuscript').oninput = () => { $('#char-count').textContent = $('#manuscript').value.length + ' 字符'; };
$('#example').onclick = () => {
  $('#field').value = '材料科学'; $('#direction').value = '热电材料与声子输运';
  $('#manuscript').value = '在300 K时，样品的晶格热导率为0.42 W m⁻¹ K⁻¹。与对照样品相比，该数值降低了18%，但尚未确定主导机制。'; $('#manuscript').oninput();
  state.selected = new Set(['03', '07', '09']); document.querySelectorAll('.tool input').forEach(input => { input.checked = state.selected.has(input.value); }); updateSelection();
  message('已载入合成演示材料，不是文献数据。');
};
$('#file-input').onchange = event => upload([...event.target.files]);
for (const event of ['dragover', 'dragleave', 'drop']) $('#drop-zone').addEventListener(event, e => { e.preventDefault(); $('#drop-zone').classList.toggle('dragging', event === 'dragover'); if (event === 'drop') upload([...e.dataTransfer.files]); });
$('#clear-tasks').onclick = () => { state.selected.clear(); document.querySelectorAll('.tool input').forEach(input => { input.checked = false; }); updateSelection(); };
$('#run').onclick = () => act('manual'); $('#auto-run').onclick = () => act('auto'); $('#prepare').onclick = () => act('prepare');
$('#model-open').onclick = () => $('#model-dialog').showModal(); $('#model-close').onclick = () => $('#model-dialog').close();
$('#model-save').onclick = () => {
  state.config = draftModel(); state.token = $('#service-token').value;
  const checked = state.checkedModel?.fingerprint === modelFingerprint(state.config);
  $('#connection').textContent = checked ? '已连接 · ' + state.checkedModel.reported : modelAvailable() ? '模型配置已填写 · 尚未验证' : '公开版 · 模型未配置';
  $('#model-dialog').close();

};
$('#model-provider').onchange = () => applyProvider($('#model-provider').value);
$('#free-only').onchange = () => {
  modelChanged(); renderProviders();
  const provider = providerById($('#model-provider').value);
  if ($('#free-only').checked && provider?.group !== 'local' && !provider?.models.some(model => model.id === $('#model-name').value && model.cost === 'free_api')) $('#model-name').value = provider?.models.find(model => model.cost === 'free_api')?.id || '';
  fillModelOptions(provider?.models || []);
};
$('#model-preset').onchange = () => { if ($('#model-preset').value) $('#model-name').value = $('#model-preset').value; modelChanged(); };
for (const id of ['endpoint', 'model-name', 'api-key', 'model-protocol']) $('#' + id).addEventListener('input', modelChanged);
$('#models-refresh').onclick = () => modelDiagnostic(false); $('#model-test').onclick = () => modelDiagnostic(true);
$('#document-close').onclick = $('#document-done').onclick = () => { $('#document-dialog').close(); renderDocuments(); };
$('#page-select').onchange = renderBlocks;
$('#select-all-blocks').onclick = () => { state.selection[state.inspecting.id] = state.inspecting.blocks.map(block => block.id); renderBlocks(); renderDocuments(); };
$('#clear-blocks').onclick = () => { state.selection[state.inspecting.id] = []; renderBlocks(); renderDocuments(); };
$('#export-recognition').onclick = () => save(JSON.stringify({ ...state.inspecting, corrections: state.edits[state.inspecting.id], selected_blocks: state.selection[state.inspecting.id], review_records: state.reviews[state.inspecting.id] }, null, 2), '识别核对记录.json', 'application/json');
$('#external-open').onclick = () => $('#external-dialog').showModal(); $('#external-close').onclick = () => $('#external-dialog').close();
$('#external-file').onchange = async event => {
  try { const file = event.target.files[0]; if (!file) return; const doc = await api('/api/documents', { filename: file.name, content_base64: await readFile(file) }); $('#external-text').value = doc.text; removeDocument(doc.id); }
  catch (error) { message(error.message, 'error'); }
};
$('#external-compare').onclick = async () => {
  try {
    const revised = $('#external-text').value; if (!revised.trim()) throw Error('请粘贴或导入最终正文。');
    busy(true, '正在比对最初原文与最终稿。'); const body = snapshot(materials());
    const comparison = await api('/api/compare', { ...body, revised });
    if (!comparison.original.trim()) throw Error('请在主界面提供待处理原稿；参考资料不会作为原稿。');
    state.resultBody = body; renderResult({ status: 'external_draft', original_text: comparison.original, final_text: revised, comparison, steps: [] });
    $('#external-dialog').close(); tab('comparison'); message('累计对照已生成；外部终稿的处理过程未由工作台验证。');
  } catch (error) { message(error.message, 'error'); } finally { busy(false); }
};
document.querySelectorAll('.tab').forEach(button => { button.onclick = () => tab(button.dataset.tab); });
$('#copy').onclick = async () => { try { await navigator.clipboard.writeText(exportText()); message('已复制。'); } catch { message('请在结果区域选中文字复制。', 'error'); } };
$('#download').onclick = exportFile;
api('/api/health').then(health => { state.serverModel = health.model_configured; return api('/api/catalog'); }).then(async catalog => { state.tasks = catalog.tasks; renderTasks(); await loadProviders(); }).catch(error => { message(error.message, 'error'); $('#model-dialog').showModal(); });
