// 화면 확정 규칙(sovereign-ax/design-system/README.md "v3.0 확정 기준") 검사.
// 사용: node scripts/design-check.mjs            어긋난 곳이 기준선보다 늘면 실패
//       node scripts/design-check.mjs --list     어긋난 곳을 모두 찍는다
//       node scripts/design-check.mjs --update   줄었을 때 기준선을 낮춘다(늘었으면 쓰지 않고 실패)
import fs from 'node:fs';
import path from 'node:path';

const POC = path.resolve(import.meta.dirname, '..');
const SHELL = path.join(POC, 'apps/desktop/static/shell');
const BUNDLE = path.resolve(POC, '../sovereign-ax/design-system/components/bundle.css');
export const BASELINE_PATH = path.join(POC, 'tests/design-baseline.json');
const UI_FILE = 'shell-ui.js';
const SKIP_JS = new Set(['common-passwords.js']);

export const RULES = {
  'card-border': '카드에 테두리, 안쪽 선, 띠를 더하지 않는다. 종류와 상태는 제목 앞 아이콘으로 알린다.',
  'actions-order': '단추 줄의 맨 앞은 가장 중요한 단추다.',
  'modal-adhoc': `모달과 단추 줄은 ${UI_FILE}의 공용 부품으로만 만든다.`,
  'raw-color': '색은 토큰(var(--이름))으로만 쓴다.',
  'middle-dot': '화면 글에 가운데점을 쓰지 않는다.',
};

const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const lineOf = (s, i) => s.slice(0, i).split('\n').length;

function scanCss(file, rel, out) {
  const src = stripCss(fs.readFileSync(file, 'utf8'));
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    const body = m[2];
    const line = lineOf(src, m.index + m[1].length);
    const hit = (rule, text) => out.push({ rule, file: rel, line, text: `${sel} { ${text.trim()} }` });
    const focus = /:focus|\[aria-invalid|\.is-bad|\.is-focus/.test(sel);
    if (/card/.test(sel) && !focus) {
      for (const d of body.matchAll(/(?:^|;)\s*((?:border(?:-(?:top|right|bottom|left|color))?|outline)\s*:\s*(?!\s|0\b|none\b)[^;]+|box-shadow\s*:\s*inset[^;]+)/g)) hit('card-border', d[1]);
    }
    for (const d of body.matchAll(/[a-z-]+\s*:[^;]*#[0-9a-fA-F]{3,8}\b[^;]*/g)) hit('raw-color', d[0]);
  }
}

/** 주석을 같은 길이의 빈칸으로 바꾼다(줄 번호 유지). 문자열 안의 //는 건드리지 않는다. */
function stripJs(src) {
  let out = '';
  let i = 0;
  let q = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (q) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === q) q = null;
      i++;
    } else if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      if (c === "'" || c === '"' || c === '`') q = c;
      out += c;
      i++;
    }
  }
  return out;
}

function scanJs(file, rel, out) {
  const lines = stripJs(fs.readFileSync(file, 'utf8')).split('\n');
  const shared = path.basename(file) === UI_FILE;
  lines.forEach((text, i) => {
    const hit = (rule) => out.push({ rule, file: rel, line: i + 1, text: text.trim().slice(0, 160) });
    if (/sx-card\b/.test(text) && (/\bis-turn\b/.test(text) || /sx-card[^'"`]*\bis-attention\b/.test(text))) hit('card-border');
    if (!shared && /['"`](modal-scrim|modal-acts)\b/.test(text)) hit('modal-adhoc');
    if (/['"`][^'"`\n]*·[^'"`\n]*['"`]/.test(text) && !/split\(|RegExp|\/\[/.test(text)) hit('middle-dot');
    if (/(modal-acts|sx-actions)/.test(text)) {
      const kinds = [...text.matchAll(/\bbtn\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)].map((m) => /sx-btn-(primary|approve)/.test(m[1]));
      if (kinds.length > 1 && !kinds[0] && kinds.includes(true)) hit('actions-order');
    }
  });
}

export function scan() {
  const out = [];
  const rel = (f) => path.relative(path.resolve(POC, '..'), f).split(path.sep).join('/');
  scanCss(BUNDLE, rel(BUNDLE), out);
  for (const name of fs.readdirSync(SHELL).sort()) {
    const f = path.join(SHELL, name);
    if (name.endsWith('.css')) scanCss(f, rel(f), out);
    else if (name.endsWith('.js') && !SKIP_JS.has(name)) scanJs(f, rel(f), out);
  }
  return out;
}

export function count(hits) {
  const c = {};
  for (const h of hits) ((c[h.rule] ??= {})[h.file] = (c[h.rule][h.file] ?? 0) + 1);
  return Object.fromEntries(Object.keys(c).sort().map((r) => [r, Object.fromEntries(Object.keys(c[r]).sort().map((f) => [f, c[r][f]]))]));
}

/** 기준선보다 늘어난 곳과 줄어든 곳. 늘면 실패, 줄면 기준선을 다시 쓰라고 알린다. */
export function compare(now, base) {
  const worse = [];
  const better = [];
  for (const rule of new Set([...Object.keys(now), ...Object.keys(base)])) {
    for (const file of new Set([...Object.keys(now[rule] ?? {}), ...Object.keys(base[rule] ?? {})])) {
      const a = now[rule]?.[file] ?? 0;
      const b = base[rule]?.[file] ?? 0;
      if (a > b) worse.push({ rule, file, now: a, base: b });
      if (a < b) better.push({ rule, file, now: a, base: b });
    }
  }
  return { worse, better };
}

export const readBaseline = () => JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const hits = scan();
  const now = count(hits);
  if (process.argv.includes('--update')) {
    // 기준선은 줄이기만 한다. 어느 파일이든 늘었으면 쓰지 않고 실패한다.
    const { worse } = compare(now, readBaseline());
    if (worse.length) {
      for (const w of worse) console.error(`어긋남이 늘어 기준선을 쓰지 않았어요. ${w.rule} ${w.file}: ${w.base} → ${w.now}곳`);
      process.exit(1);
    }
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(now, null, 2)}\n`);
    console.log(`기준선을 다시 썼어요: ${hits.length}곳`);
  } else {
    if (process.argv.includes('--list')) for (const h of hits) console.log(`${h.rule}\t${h.file}:${h.line}\t${h.text}`);
    const { worse, better } = compare(now, readBaseline());
    for (const w of worse) {
      console.error(`어긋남 ${w.rule} ${w.file}: ${w.base} → ${w.now}곳. ${RULES[w.rule]}`);
      for (const h of hits.filter((x) => x.rule === w.rule && x.file === w.file)) console.error(`  ${h.file}:${h.line}  ${h.text}`);
    }
    for (const b of better) console.log(`줄었어요 ${b.rule} ${b.file}: ${b.base} → ${b.now}곳. node scripts/design-check.mjs --update 로 기준선을 낮춰 주세요.`);
    console.log(`어긋난 곳 ${hits.length}곳(기준선과 비교)`);
    if (worse.length) process.exit(1);
  }
}
