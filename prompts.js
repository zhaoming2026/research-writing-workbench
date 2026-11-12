async function loadAsset(path, method) {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) throw Error('工作台资源载入失败，请刷新页面后重试。');
  return response[method]();
}

export const catalog = loadAsset('./catalog.json', 'json');
export const policy = loadAsset('./policy.md', 'text');
export const providers = loadAsset('./providers.json', 'json');

const sourceStatus = document.querySelector('#source-status');
const sourceUpload = document.querySelector('#source-upload');
const sourceFileLink = document.querySelector('#source-file-link');
let sourceText, sourceRequest;
const templates = new Map();

export function sourceUrl(meta) {
  return `https://github.com/${meta.repository}/blob/${meta.commit}/README.md`;
}
catalog.then(data => { sourceFileLink.href = sourceUrl(data.source); }).catch(() => {});

async function sha256(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
}

async function verifySource(bytes, meta) {
  if (await sha256(bytes) !== meta.readme_sha256) throw Error('文件校验失败，请使用链接所指固定版本的原版 README.md。');
  sourceStatus.textContent = '原版 README.md 已载入并通过 SHA-256 校验。';
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

sourceUpload.onchange = async () => {
  try {
    const file = sourceUpload.files[0];
    if (!file) return;
    if (file.size > 1024 * 1024) throw Error('请选择原帖的 README.md 文件。');
    sourceText = await verifySource(await file.arrayBuffer(), (await catalog).source);
  } catch (error) {
    sourceStatus.textContent = error.message;
  } finally { sourceUpload.value = ''; }
};

async function getSource(meta) {
  if (sourceText) return sourceText;
  if (!sourceRequest) {
    sourceStatus.textContent = '正在从原作者仓库读取固定版本……';
    sourceRequest = (async () => {
      try {
        const url = `https://raw.githubusercontent.com/${meta.repository}/${meta.commit}/README.md`;
        const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(9000) });
        if (!response.ok) throw Error('原帖资源未返回。');
        sourceText = await verifySource(await response.arrayBuffer(), meta);
        return sourceText;
      } catch {
        if (sourceText) return sourceText;
        sourceStatus.textContent = '原帖暂未加载。请下载固定版本的原版 README.md 并导入。';
        sourceStatus.closest('details').open = true;
        throw Error('原帖暂未加载，请通过「原帖加载与离线导入」载入原版 README.md 后重试。');
      } finally { sourceRequest = null; }
    })();
  }
  return sourceRequest;
}

async function templateFor(task, meta) {
  if (templates.has(task.id)) return templates.get(task.id);
  const source = await getSource(meta);
  let value = source.slice(task.start, task.start + task.length);
  for (const [start, length, replacement] of task.edits) {
    value = value.slice(0, start) + replacement + value.slice(start + length);
  }
  if (await sha256(new TextEncoder().encode(value)) !== task.template_sha256) {
    throw Error('功能 ' + task.id + ' 的模板完整性校验失败。');
  }
  templates.set(task.id, value);
  return value;
}

export function selectTasks(data, ids) {
  const tasks = ids.map(id => data.tasks.find(task => task.id === String(id).padStart(2, '0')));
  if (tasks.some(task => !task) || new Set(tasks).size !== tasks.length) {
    throw Error('功能选择包含未知或重复编号。');
  }
  for (const [a, b, label] of [
    ['05', '06', '精简与扩写'], ['01', '03', '不同翻译格式'], ['01', '02', '相反翻译方向'],
    ['03', '02', '相反翻译方向'], ['07', '08', '不同润色语言'], ['10', '11', '不同自然化语言']
  ]) {
    if (tasks.some(t => t.id === a) && tasks.some(t => t.id === b)) {
      throw Error(`功能 ${a} 与 ${b} 的目标冲突（${label}），请分别处理。`);
    }
  }
  return tasks;
}

export function orderTasks(tasks) {
  const ids = tasks.map(t => t.id);
  const order = ids.includes('01') || ids.includes('03')
    ? ['04', '08', '11', '01', '03', '07', '10', '05', '06', '09']
    : ids.includes('02') ? ['07', '10', '05', '06', '02', '08', '11', '09']
      : ['04', '07', '08', '05', '06', '10', '11', '09'];
  const rank = task => order.includes(task.id) ? order.indexOf(task.id) : 100 + Number(task.id);
  return [...tasks].sort((a, b) => rank(a) - rank(b));
}

function section(text, names) {
  const heading = /^\s*(?:#{1,6}\s*)?(?:\d+(?:\.\d+)*[.)、]?\s*)?(Abstract|摘要|关键词|Keywords|Introduction|引言|Methods?|Methodology|Materials and Methods|方法|材料与方法|实验方法|计算方法|Results?|结果|Discussion|讨论|Conclusions?|结论|References|参考文献)(?=\s|[:：]|$)\s*[:：]?\s*(.*)$/i;
  const lines = [];
  let active = false;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(heading);
    if (!match) {
      if (active) lines.push(line);
      continue;
    }
    if (active) break;
    if (names.includes(match[1].toLowerCase())) {
      active = true;
      lines.push(match[2]);
    }
  }
  return lines.join('\n').trim();
}

export async function bindTask(task, meta, profile, text, material = text) {
  const template = await templateFor(task, meta);
  const values = {
    field: profile.field,
    research_direction: profile.research_direction,
    venue_scope: profile.target_venue || profile.field + '领域的学术期刊或会议规范',
    glossary_examples: '本研究的专有名词、关键方法与通用缩写',
    input_text: text,
    abstract: section(material, ['abstract', '摘要']) || '未定位到单独摘要。检查本次完整材料，缺少时说明，不编造。',
    methodology: section(material, ['method', 'methods', 'methodology', 'materials and methods', '方法', '材料与方法', '实验方法', '计算方法']) || text,
  };
  return '研究领域：' + values.field + '\n具体研究方向：' + values.research_direction + '\n\n'
    + template.replace(/\{\{(\w+)\}\}/g, (full, name) => values[name] ?? full);
}

export async function prepare(body, material) {
  const profile = body.profile;
  if (!profile?.field?.trim() || !profile?.research_direction?.trim()) throw Error('请填写研究领域与具体方向。');
  if (!material.context.trim()) throw Error('请粘贴内容或选择已识别的文件范围。');
  if (material.context.length > 100000) throw Error('本次材料超过 10 万字符，请按章节选择范围。');
  const data = await catalog;
  const tasks = body.auto ? data.tasks : orderTasks(selectTasks(data, body.task_ids || []));
  if (!tasks.length) throw Error('请选择一项或多项功能。');
  const reference = '读取末尾本次请求 JSON 的 input.text，作为本步骤材料。';
  const taskText = await Promise.all(tasks.map(async task => {
    const url = sourceUrl(data.source) + '#L' + task.source_start_line + '-L' + task.source_end_line;
    return `### ${task.id} · ${task.title}\n\n[该功能的原帖出处](${url})\n\n` + await bindTask(task, data.source, profile, reference, material.context);
  }));
  const request = { profile, mode: body.auto ? 'auto' : 'manual', task_ids: body.auto ? [] : tasks.map(t => t.id), input: { text: material.context } };
  const prompt = '# 本次科研写作请求\n\n按以下档案与规则处理末尾 JSON 数据中的稿件。\n\n' + await policy
    + '\n\n## 所选任务的完整规则\n\n' + taskText.join('\n\n')
    + '\n\n原版来源 [Leey21 / awesome-ai-research-writing](' + sourceUrl(data.source) + ')'
    + '\n\n## 本次请求（JSON 数据）\n' + JSON.stringify(request, null, 2);
  return { prompt, tasks, data };
}
