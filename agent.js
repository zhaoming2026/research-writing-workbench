import { catalog, policy, templateFor, bindTask, orderTasks, selectTasks, sourceUrl } from './prompts.js';
import { zipSync, strToU8 } from './vendor/fflate/browser.js';

const $ = selector => document.querySelector(selector);
const selected = new Set();
const configuration = fetch(new URL('./agent-config.json', import.meta.url)).then(response => {
  if (!response.ok) throw Error('智能体菜单配置读取失败。');
  return response.json();
});
let currentRequest;
let inputRevision = 0;
let parentOrigin;
try {
  const value = new URLSearchParams(location.search).get('host_origin');
  if (value) {
    const url = new URL(value);
    if (url.origin === value && ['https:', 'http:'].includes(url.protocol)) parentOrigin = url.origin;
  }
} catch { /* Standalone mode keeps copy and download available. */ }

function message(text, error = false) {
  $('#status').textContent = text;
  $('#status').classList.toggle('error', error);
}
function invalidate() {
  inputRevision++;
  currentRequest = null;
  $('#preview').hidden = true;
}
function updateSelection() {
  document.querySelectorAll('.task').forEach(label => label.classList.toggle('selected', selected.has(label.dataset.id)));
  $('#selection-status').textContent = $('#automatic').checked ? '自动处理 · 由智能体按材料选择'
    : selected.size ? '已选 ' + [...selected].sort().join(' + ') : '选择一项或多项功能';
  invalidate();
}
function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
}
async function render() {
  const data = await catalog;
  const groups = $('#task-groups');
  for (const [title, start, end] of [['翻译与草稿', 1, 4], ['表达、篇幅与逻辑', 5, 11], ['图表与研究分析', 12, 17]]) {
    groups.append(node('div', title, 'group-title'));
    const grid = node('div', undefined, 'task-grid');
    for (const task of data.tasks.filter(task => Number(task.id) >= start && Number(task.id) <= end)) {
      const label = node('label', undefined, 'task'); label.dataset.id = task.id;
      const input = node('input'); input.type = 'checkbox'; input.value = task.id; input.setAttribute('aria-label', task.id + ' ' + task.title);
      input.onchange = () => {
        if (input.checked) { selected.add(task.id); $('#automatic').checked = false; }
        else selected.delete(task.id);
        updateSelection();
      };
      label.append(node('span', task.id, 'task-number'), node('span', task.title, 'task-name'), input);
      grid.append(label);
    }
    groups.append(grid);
  }
  if (parentOrigin && window.parent !== window) {
    $('#send-host').hidden = false;
    window.parent.postMessage({ type: 'research-writing.ready', version: 1 }, parentOrigin);
  }
}
async function sourceNote() {
  return '提示词来源 [Leey21 / awesome-ai-research-writing](' + sourceUrl((await catalog).source) + ')。领域、方向与输入使用本次实际设置。';
}
async function prepareRequest() {
  if (!$('#request-form').reportValidity()) throw Error('请先填写研究领域和具体方向。');
  const revision = inputRevision;
  const config = await configuration;
  const data = await catalog;
  const automatic = $('#automatic').checked;
  const tasks = automatic ? data.tasks : orderTasks(selectTasks(data, [...selected].sort()));
  if (!tasks.length) throw Error('请选择一项或多项功能，或使用自动处理。');
  const text = $('#material').value.trim();
  if (text.length > 100000) throw Error('本次文字超过10万字符，请按章节处理。');
  const profile = { field: $('#field').value.trim(), research_direction: $('#direction').value.trim(), target_venue: $('#venue').value.trim() };
  const request = { profile, task_ids: automatic ? [] : tasks.map(task => task.id), auto: automatic, text };
  const input = '从末尾请求数据的 text 读取本次材料。text 为空时，先读取宿主当前对话中已提供的实际附件。材料不可见时请补问用户。';
  const rules = await Promise.all(tasks.map(async task => '### ' + task.id + ' · ' + task.title + '\n\n'
    + await bindTask(task, data.source, profile, input, text)));
  const prompt = config.instructions + '\n\n# 本次完整执行规则\n\n' + rules.join('\n\n')
    + '\n\n# 本次选择与材料\n\n' + JSON.stringify(request, null, 2);
  if (revision !== inputRevision) throw Error('输入或功能选择已更改，请重新生成请求。');
  return { type: 'research-writing.submit', version: 1, request, prompt, source: data.source.repository };
}
async function action(button, callback) {
  if (button.disabled) return;
  button.disabled = true;
  try { await callback(); } catch (error) { message(error.message, true); }
  finally { button.disabled = false; }
}
function showRequest(value) {
  currentRequest = value;
  $('#request-output').value = value.prompt;
  $('#preview').hidden = false;
}
$('#request-form').onsubmit = event => {
  event.preventDefault();
  action($('#prepare'), async () => {
    message('正在绑定领域与完整任务规则……');
    showRequest(await prepareRequest());
    message('完整请求已生成，可复制给你使用的智能体。');
  });
};
$('#send-host').onclick = () => action($('#send-host'), async () => {
  const value = await prepareRequest();
  showRequest(value);
  window.parent.postMessage(value, parentOrigin);
  message('本次请求已发送到宿主页面，请在智能体中查看执行状态。');
});
$('#automatic').onchange = () => {
  if ($('#automatic').checked) {
    selected.clear();
    document.querySelectorAll('.task input').forEach(input => { input.checked = false; });
  }
  updateSelection();
};
$('#clear-tasks').onclick = () => {
  selected.clear(); $('#automatic').checked = false;
  document.querySelectorAll('.task input').forEach(input => { input.checked = false; });
  updateSelection();
};
for (const name of ['field', 'direction', 'venue', 'material']) $('#' + name).oninput = invalidate;
$('#copy-request').onclick = () => action($('#copy-request'), async () => {
  if (!currentRequest) throw Error('选择已改变，请重新生成完整请求。');
  try {
    await navigator.clipboard.writeText(currentRequest.prompt);
    message('完整请求已复制。');
  } catch {
    $('#request-output').focus(); $('#request-output').select();
    message('请复制下方已选中的完整文本。');
  }
});

async function portableFiles() {
  const config = await configuration;
  const data = await catalog;
  const note = await sourceNote();
  const templateEntries = await Promise.all(data.tasks.map(async task => {
    const template = await templateFor(task, data.source);
    return { task, template, body: '# ' + task.id + ' · ' + task.title + '\n\n' + template + '\n' + note };
  }));
  const rules = templateEntries.map(item => '### ' + item.task.id + ' · ' + item.task.title + '\n\n' + item.template).join('\n\n');
  const response = await fetch(new URL('./agent-readme.md', import.meta.url));
  if (!response.ok) throw Error('使用说明读取失败，请刷新后重试。');
  const files = {
    '开始使用.md': await response.text(),
    '直接粘贴完整版.md': config.instructions + '\n\n# 完整功能规则\n\n' + rules + '\n' + note,
    '智能体主指令.md': config.instructions,
    '开场菜单.md': config.welcome,
    '功能选项.json': JSON.stringify(config, null, 2),
    'knowledge/policy.md': await policy,
  };
  for (const item of templateEntries) files['knowledge/task-' + item.task.id + '.md'] = item.body;
  files['完整性校验.json'] = JSON.stringify({
    task_count: templateEntries.length, source_code_blocks: data.original_code_block_count,
    included_code_blocks: rules.split(String.fromCharCode(96).repeat(4) + 'markdown').length - 1,
    sections: templateEntries.map(({ task }) => ({ id: task.id, template_sha256: task.template_sha256 })),
  }, null, 2);
  return files;
}
$('#copy-agent').onclick = () => action($('#copy-agent'), async () => {
  message('正在加载17项完整规则……');
  const files = await portableFiles();
  showRequest({ prompt: files['直接粘贴完整版.md'] });
  try {
    await navigator.clipboard.writeText(currentRequest.prompt);
    message('单文件完整版已复制。粘贴到新对话后发送「开始」。');
  } catch {
    $('#request-output').focus(); $('#request-output').select();
    message('完整版已生成，请复制下方选中的全文，粘贴到新对话后发送「开始」。');
  }
});
$('#download-agent').onclick = () => action($('#download-agent'), async () => {
  message('正在打包完整规则与功能菜单……');
  const files = await portableFiles();
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
  anchor.download = '智能体通用嵌入版.zip'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 2000);
  message('嵌入包已下载。普通聊天使用「直接粘贴完整版.md」，智能体配置使用主指令与 knowledge 文件夹。');
});
render().catch(error => message(error.message, true));
