import { unzipSync, zipSync, strToU8 } from './vendor/fflate/browser.js';

const MAX_FILE = 30 * 1024 * 1024;
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const mathNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const decoder = new TextDecoder('utf-8', { fatal: true });
const serializer = new XMLSerializer();
const files = new Map();
let pdfLibrary;

function asset(path) {
  return new URL(path, import.meta.url).href;
}

function wordText(element) {
  if (element.namespaceURI === mathNamespace && ['oMath', 'oMathPara'].includes(element.localName)) {
    return '【公式对象：' + [...element.getElementsByTagNameNS(mathNamespace, 't')].map(t => t.textContent).join(' ') + '】';
  }
  if (element.namespaceURI === wordNamespace) {
    if (element.localName === 't') return element.textContent;
    if (element.localName === 'tab') return '\t';
    if (['br', 'cr'].includes(element.localName)) return '\n';
    if (['del', 'moveFrom'].includes(element.localName)) return '';
  }
  return [...element.children].map(wordText).join('');
}

function paragraphs(element) {
  return [...element.children].filter(child => child.localName === 'p').map(wordText).join('\n').trim();
}

function readWord(bytes) {
  const file = unzipSync(bytes, { filter: entry => {
    if (entry.name !== 'word/document.xml') return false;
    if (entry.originalSize > 30 * 1024 * 1024) throw Error('Word 正文解压后超过 30 MB。');
    return true;
  } })['word/document.xml'];
  if (!file) throw Error('此文件缺少 Word 正文。请选择有效的 .docx 文件。');
  const xml = new DOMParser().parseFromString(decoder.decode(file), 'application/xml');
  const body = xml.getElementsByTagNameNS(wordNamespace, 'body')[0];
  if (!body || xml.querySelector('parsererror')) throw Error('Word 正文 XML 无法识别。');
  const blocks = [];
  function add(element, parentLocation = '') {
    if (!['p', 'tbl'].includes(element.localName)) {
      if (['sdt', 'sdtContent', 'customXml'].includes(element.localName)) {
        for (const child of element.children) add(child, parentLocation);
      }
      return;
    }
    const table = element.localName === 'tbl';
    const math = [...element.getElementsByTagNameNS(mathNamespace, 'oMath')].map(m => ({ raw_xml: serializer.serializeToString(m) }));
    const location = parentLocation + (table ? '表格块 ' : '正文段落块 ') + (blocks.length + 1);
    const rows = table ? [...element.children].filter(row => row.localName === 'tr').map(row =>
      [...row.children].filter(cell => cell.localName === 'tc').map(paragraphs)) : null;
    const text = table ? rows.map(row => row.join(' | ')).join('\n') : wordText(element).trim();
    if (text || math.length) blocks.push({ kind: table ? 'table' : 'paragraph', location, text, math, ...(table ? { rows } : {}) });
  }
  for (const element of body.children) add(element);
  const warnings = ['DOCX 读取正文、表格和公式对象。请对照源文件核对公式结构、表格、自动编号与版面。图像、批注及页眉页脚不计入正文。'];
  if (body.getElementsByTagNameNS(wordNamespace, 'drawing').length) warnings.push('检测到图像对象，图像内容未作为正文识别。');
  return { blocks, warnings };
}

async function getPDF(bytes) {
  pdfLibrary ||= import('./vendor/pdf/pdf.min.mjs');
  const pdfjs = await pdfLibrary;
  pdfjs.GlobalWorkerOptions.workerSrc = asset('./vendor/pdf/pdf.worker.min.mjs');
  return pdfjs.getDocument({
    data: bytes, isEvalSupported: false, enableXfa: false,
    cMapUrl: asset('./vendor/pdf/cmaps/'), cMapPacked: true,
    standardFontDataUrl: asset('./vendor/pdf/standard_fonts/'),
    wasmUrl: asset('./vendor/pdf/wasm/'), iccUrl: asset('./vendor/pdf/iccs/'),
  }).promise;
}

async function renderPage(page, width) {
  const natural = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / Math.max(natural.width, natural.height / 1.5) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas;
}

function extractText(items) {
  let previous, text = '';
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    if (previous && !previous.hasEOL) {
      const dy = Math.abs(item.transform[5] - previous.transform[5]);
      const dx = item.transform[4] - previous.transform[4] - previous.width;
      if (dy > Math.max(3, previous.height * .55)) text += '\n';
      else if (dx > Math.max(1, previous.height * .13) && !/\s$/.test(text)) text += ' ';
    }
    text += item.str + (item.hasEOL ? '\n' : '');
    previous = item;
  }
  return text.trim();
}

async function readPdf(bytes, forceOcr) {
  const pdf = await getPDF(bytes);
  const blocks = [], warnings = ['PDF 按页读取可见文字。请用页面预览核对分栏顺序、公式和表格。'];
  if (pdf.numPages > 150) {
    await pdf.destroy();
    throw Error('此 PDF 超过 150 页，请拆分后上传需要处理的章节。');
  }
  let worker, keep = false;
  try {
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const { items } = await page.getTextContent();
      let text = extractText(items), method = 'pdf_text', review = false;
      if (forceOcr || text.replace(/\s/g, '').length < 20) {
        try {
          if (!worker) {
            const { default: { createWorker } } = await import('./vendor/ocr/tesseract.esm.min.js');
            worker = await createWorker(['chi_sim', 'eng'], 1, {
              workerPath: asset('./vendor/ocr/worker.min.js'), workerBlobURL: false,
              corePath: asset('./vendor/ocr/tesseract-core-lstm.wasm.js'),
              langPath: asset('./vendor/ocr/lang/').replace(/\/$/, ''), cacheMethod: 'none',
            });
          }
          const canvas = await renderPage(page, 1700);
          try {
            const { data } = await worker.recognize(canvas);
            if (data.text.trim()) {
              text = data.text.trim();
              method = 'browser_ocr';
              review = true;
              warnings.push(`第 ${number} 页使用中英文 OCR，请核对字形、数字与公式。`);
            } else warnings.push(`第 ${number} 页未识别到有效 OCR 文字，请检查页面预览。`);
          } finally { canvas.width = 0; }
        } catch {
          warnings.push(`第 ${number} 页的 OCR 未完成。请查看页面预览或粘贴校对后的文字。`);
        }
      }
      if (text) blocks.push({ text, location: '第 ' + number + ' 页', page: number, kind: 'paragraph', method, review });
      else warnings.push('第 ' + number + ' 页无可用识别文字，未计入处理范围。');
      page.cleanup();
    }
    keep = true;
    return { pdf, blocks, warnings, page_count: pdf.numPages };
  } finally {
    if (worker) await worker.terminate();
    if (!keep) await pdf.destroy();
  }
}

export async function importDocument(body) {
  if (!body.filename || !body.content_base64) throw Error('文件为空，或浏览器无法读取。');
  if (body.content_base64.length > Math.ceil(MAX_FILE / 3) * 4) throw Error('单文件大小上限为 30 MB。');
  const bytes = Uint8Array.from(atob(body.content_base64), value => value.charCodeAt(0));
  const extension = body.filename.split('.').pop().toLowerCase();
  let result;
  if (extension === 'pdf') result = await readPdf(bytes, body.force_ocr);
  else if (extension === 'docx') result = readWord(bytes);
  else if (['txt', 'md', 'tex', 'csv', 'json'].includes(extension)) {
    const blocks = decoder.decode(bytes).split(/\r?\n\s*\r?\n/).filter(text => text.trim())
      .map((text, i) => ({ text, location: '文本段落 ' + (i + 1), kind: 'paragraph' }));
    result = { blocks, warnings: [] };
  } else throw Error('请选择 PDF、DOCX、TXT、Markdown、LaTeX、CSV 或 JSON。');
  const id = crypto.randomUUID();
  const blocks = result.blocks.map((block, i) => ({ ...block, id: 'B' + String(i + 1).padStart(4, '0') }));
  if (!blocks.length && !result.page_count) throw Error('文件没有可用于处理的正文。');
  const doc = { id, filename: body.filename, blocks, warnings: result.warnings,
    page_count: result.page_count ?? null, text: blocks.map(block => block.text).join('\n\n') };
  files.set(id, { doc, pdf: result.pdf });
  return doc;
}

export function removeDocument(id) {
  files.get(id)?.pdf?.destroy().catch(() => {});
  files.delete(id);
}

export async function previewPage(id, number) {
  const page = await files.get(id)?.pdf?.getPage(number);
  if (!page) throw Error('PDF 页面预览已失效。');
  const canvas = await renderPage(page, 1250);
  try {
    return await new Promise((resolve, reject) => canvas.toBlob(blob =>
      blob ? resolve(blob) : reject(Error('页面预览生成失败。')), 'image/png'));
  } finally { canvas.width = 0; page.cleanup(); }
}

export function assembleMaterials(body) {
  const pasted = body.text || '';
  const context = pasted.trim() ? ['【直接粘贴的待处理稿】\n' + pasted] : [];
  const original = pasted.trim() ? [pasted] : [];
  const sources = pasted.split(/\n\s*\n/).filter(text => text.trim()).map((text, i) => ({
    text, location: '粘贴段落 ' + (i + 1), block_id: 'P' + (i + 1), role: 'manuscript'
  }));
  const roles = { manuscript: '待处理稿', data: '数据材料', reference: '参考资料', guidelines: '投稿规范' };
  for (const id of body.document_ids || []) {
    const doc = files.get(id)?.doc;
    if (!doc) throw Error('有文件已移除，请重新导入后再处理。');
    const role = body.document_roles?.[id] || 'manuscript';
    const selected = new Set(body.document_selection?.[id] ?? doc.blocks.map(block => block.id));
    const warnings = [...doc.warnings];
    const selectedText = [];
    for (const block of doc.blocks) {
      if (!selected.has(block.id)) continue;
      const text = body.document_edits?.[id]?.[block.id] ?? block.text;
      if (!text.trim()) continue;
      if (role === 'manuscript') original.push(text);
      sources.push({ text, role, filename: doc.filename, location: block.location,
        page: block.page, block_id: block.id, document_id: id });
      const audit = body.document_reviews?.[id]?.[block.id];
      const needsReview = (block.math?.length || block.rows || block.review) && audit?.status !== 'verified';
      selectedText.push('[' + block.location + ' · ' + block.id + (needsReview ? ' · 待核对' : '') + ']\n' + text);
    }
    if (selectedText.length) context.push('【' + roles[role] + ' · ' + doc.filename + '】\n'
      + (warnings.length ? '识别说明（非论文正文）：' + warnings.join(' ') + '\n' : '') + selectedText.join('\n\n'));
  }
  return { context: context.join('\n\n'), original: original.join('\n\n'), sources };
}

function xmlText(text) {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export function wordExport(text) {
  const parts = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<w:document xmlns:w="' + wordNamespace + '"><w:body>' + text.split(/\r?\n/).map(line =>
      '<w:p><w:r><w:t xml:space="preserve">' + xmlText(line) + '</w:t></w:r></w:p>').join('') + '</w:body></w:document>',
  };
  return zipSync(Object.fromEntries(Object.entries(parts).map(([name, value]) => [name, strToU8(value)])));
}
