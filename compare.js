import { diffArrays } from './vendor/diff/array.js';

function sentences(text) {
  return text.split(/(?:\r?\n)+/).flatMap(line => {
    // Decimal points, abbreviations and citation fragments belong with their sentence.
    const parts = line.trim().split(/(?<=[。！？!?])\s*|(?<=[A-Za-z0-9)\]]\.)\s+(?=[A-Z0-9])/u);
    return parts.reduce((result, part) => {
      if (!part) return result;
      const previous = result.at(-1);
      if (previous && /(?:\b(?:al|fig|eq|dr|vs|ref|vol)\.|\b[A-Z]\.)$/i.test(previous)) result[result.length - 1] += ' ' + part;
      else result.push(part);
      return result;
    }, []);
  });
}

const flags = [
  ['数值或数值顺序有变化，请对照数据。', /[-−+]?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?\s*[%％]?/gu],
  ['否定、因果或推断限定词有变化，请核对含义。', /\b(?:not|no|may|might|could|suggest\w*|cause\w*|because|uncertain|possibly|therefore)\b|未|可能|表明|导致|推测|尚不|因此/giu],
  ['公式、引用或交叉引用有变化，请核对原始出处。', /\$[^$]+\$|\\(?:cite\w*|ref|eqref)\{[^}]+\}|\[\d+(?:\s*[,–-]\s*\d+)*\]|\b(?:Fig|Eq|Table)\.?\s*\d+|公式对象/giu],
];
const labels = { modified: '原句与终稿有文字改写，请核对学术含义。', inserted: '终稿新增内容，请确认依据。', deleted: '原稿内容在此处删除，请核对上下文。', unchanged: '原句与终稿一致。' };

export function compare(original, revised, sources = [], explanations = {}) {
  if (Math.max(original.length, revised.length) > 150000) throw Error('对照文本超过 15 万字符，请按章节比较。');
  const before = sentences(original), after = sentences(revised);
  const parts = diffArrays(before, after, { timeout: 1200 });
  if (!parts) throw Error('对照范围较大，请按章节比较。');
  const rows = [], stats = { modified: 0, inserted: 0, deleted: 0, unchanged: 0, flagged_rows: 0 };
  const add = (original, revised) => {
    const change_type = original === revised ? 'unchanged' : original && revised ? 'modified' : original ? 'deleted' : 'inserted';
    const id = 'C' + String(rows.length + 1).padStart(4, '0');
    const supplied = explanations[id];
    const review_flags = change_type === 'unchanged' ? [] : flags.filter(([, expression]) =>
      JSON.stringify((original.match(expression) || []).map(x => x.trim().toLowerCase())) !==
      JSON.stringify((revised.match(expression) || []).map(x => x.trim().toLowerCase())))
      .map(([message]) => ({ message }));
    const rowSources = [];
    if (original) for (const source of sources) {
      if (source.role === 'manuscript' && source.text.includes(original)) rowSources.push(source);
      if (rowSources.length === 3) break;
    }
    stats[change_type]++;
    if (review_flags.length) stats.flagged_rows++;
    rows.push({ id, change_type, original, revised, review_flags,
      sources: rowSources.map(({ text, ...source }) => source),
      explanation: supplied?.text?.trim() || labels[change_type],
      explanation_source: supplied?.text?.trim() ? 'supplied_' + (supplied.source || 'unspecified') : 'deterministic_diff',
    });
  };
  let removed = [], inserted = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, inserted.length); i++) add(removed[i] || '', inserted[i] || '');
    removed = [];
    inserted = [];
  };
  for (const part of parts) {
    if (part.removed) removed.push(...part.value);
    else if (part.added) inserted.push(...part.value);
    else {
      flush();
      for (const same of part.value) add(same, same);
    }
  }
  flush();
  return { original, revised, rows, stats };
}
