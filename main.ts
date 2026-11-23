
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';




class Exit2 extends Error {
  constructor(line) {
    super(line);
    this.line = line;
  }
}

class Fail extends Error {
  constructor(code, path) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const parseErr = (n) => new Exit2(`error: parse ${n}`);

const isBlank = (s) => s.trim() === '';

function patchLines(text) {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}


function safePath(p) {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function checkSafe(p) {
  if (!safePath(p)) throw new Fail('unsafe', p);
}




function splitFile(text) {
  const nl = text.indexOf('\n');
  const brk = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], brk, finalBreak: false };
  const lines = text.split(brk);
  const finalBreak = text.endsWith(brk);
  if (finalBreak) lines.pop();
  return { lines, brk, finalBreak };
}


function joinFile(f) {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.finalBreak ? f.brk : '');
}




class Tree {
  origCache = new Map();
  now = new Map();
  moves = [];

  original(p) {
    if (!this.origCache.has(p)) {
      let v = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.origCache.set(p, v);
    }
    return this.origCache.get(p);
  }

  get(p) {
    if (this.now.has(p)) return this.now.get(p);
    return this.original(p);
  }

  set(p, text) {
    this.now.set(p, text);
  }
}



const trimTrail = (s) => s.replace(/[ \t]+$/, '');
const trimBoth = (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s) => /^[ \t]*/.exec(s)[0];

const tierNorm = (tier) =>
  tier === 0 ? (s) => s : tier === 1 ? trimTrail : trimBoth;




function findOccurrences(lines, o, strict, from = 0, mustEnd = false) {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const norm = tierNorm(tier);
    const want = o.map(norm);
    const at = [];
    for (let i = from; i + o.length <= lines.length; i += 1) {
      if (mustEnd && i + o.length !== lines.length) continue;
      let ok = true;
      for (let k = 0; k < o.length; k += 1) {
        if (norm(lines[i + k]) !== want[k]) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}


function findAnchor(lines, anchor, from, strict) {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const norm = tierNorm(tier);
    const want = norm(anchor);
    for (let i = from; i < lines.length; i += 1) {
      if (norm(lines[i]) === want) return i;
    }
  }
  return null;
}





function replacement(fileLines, at, o, n, tier) {
  const f = tier === 2 ? leadWs(fileLines[at]) : '';
  const p = tier === 2 ? leadWs(o[0]) : '';
  return n.map((ln) => {
    if (ln.ctx >= 0) return fileLines[at + ln.ctx];
    if (tier === 2 && ln.text.trim() !== '' && ln.text.startsWith(p)) return f + ln.text.slice(p.length);
    return ln.text;
  });
}









function newSection() {
  return { newFile: false, delFile: false, hunks: [] };
}


function headPath(line) {
  const raw = line.slice(4).split('\t')[0].trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}


function diffGitPaths(line, lineNo) {
  const m = /^a\/(.+) b\/(.+)$/.exec(line.slice('diff --git '.length));
  if (m === null) throw parseErr(lineNo);
  return { x: m[1], y: m[2] };
}


function applyHunks(f, hunks, strict, path) {
  let d = 0;
  for (const h of hunks) {
    const o = [];
    const n = [];
    for (const b of h.body) {
      if (b.kind === ' ') {
        o.push(b.text);
        n.push({ text: b.text, ctx: o.length - 1 });
      } else if (b.kind === '-') {
        o.push(b.text);
      } else if (b.kind === '+') {
        n.push({ text: b.text, ctx: -1 });
      }
    }
    let slash = false;
    for (let i = h.body.length - 1; i >= 0; i -= 1) {
      const k = h.body[i]!.kind;
      if (k === ' ' || k === '+') {
        slash = h.body[i + 1]?.kind === '\\';
        break;
      }
    }
    if (o.length > 0) {
      const occ = findOccurrences(f.lines, o, strict);
      if (occ === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = occ.at[0];
      for (const pos of occ.at) {
        if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
      }
      const rep = replacement(f.lines, best, o, n, occ.tier);
      const toEnd = best + o.length === f.lines.length;
      f.lines.splice(best, o.length, ...rep);
      if (toEnd) f.finalBreak = !slash;
    } else {
      const at = Math.min(h.a + d, f.lines.length);
      const toEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...n.map((ln) => ln.text));
      if (toEnd) f.finalBreak = !slash;
    }
    d += n.length - o.length;
  }
}


function unifiedEdit(s, strict) {
  let oldP;
  let newP;
  if (s.pairOld !== undefined || s.pairNew !== undefined) {
    oldP = s.pairOld ?? null;
    newP = s.pairNew ?? null;
  } else {
    oldP = s.renameFrom !== undefined ? s.renameFrom : s.diffOld ?? null;
    newP = s.renameTo !== undefined ? s.renameTo : s.diffNew ?? null;
  }
  const isCreate = newP !== null && (oldP === null || s.newFile);
  const isDelete = !isCreate && (newP === null || s.delFile);
  return (tree) => {
    if (oldP !== null) checkSafe(oldP);
    if (newP !== null) checkSafe(newP);
    if (isCreate) {
      const target = newP;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const content = [];
      let lastPlusSlash = false;
      for (const h of s.hunks) {
        h.body.forEach((b, idx) => {
          if (b.kind === '+') {
            content.push(b.text);
            lastPlusSlash = h.body[idx + 1]?.kind === '\\';
          }
        });
      }
      tree.set(target, joinFile({ lines: content, brk: '\n', finalBreak: content.length > 0 && !lastPlusSlash }));
      return;
    }
    const source = oldP;
    const before = tree.get(source);
    if (before === null) throw new Fail('missing', source);
    if (isDelete) {
      tree.set(source, null);
      return;
    }
    const dest = newP;
    if (dest !== source && tree.get(dest) !== null) throw new Fail('exists', dest);
    const f = splitFile(before);
    applyHunks(f, s.hunks, strict, source);
    const out = joinFile(f);
    if (dest !== source) {
      tree.set(source, null);
      tree.set(dest, out);
      tree.moves.push({ from: source, to: dest });
    } else {
      tree.set(source, out);
    }
  };
}

function parseUnified(lines, strict) {
  const sections = [];
  let cur = null;
  const pairAt = (i) =>
    lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const { x, y } = diffGitPaths(line, i + 1);
      cur = newSection();
      cur.diffOld = x;
      cur.diffNew = y;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw parseErr(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw parseErr(i + 1);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ') || pairAt(j)) break;
        const c = bl.charAt(0);
        if (bl === '' || c === ' ' || c === '-' || c === '+' || c === '\\') {
          body.push({ kind: bl === '' ? ' ' : c, text: bl === '' ? '' : bl.slice(1), empty: bl === '' });
          j += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.empty) body.pop();
      cur.hunks.push({ a: parseInt(m[1], 10), body });
      i = j;
      continue;
    }
    if (pairAt(i)) {
      if (cur !== null && cur.hunks.length === 0 && cur.pairOld === undefined) {
        cur.pairOld = headPath(line);
        cur.pairNew = headPath(lines[i + 1]!);
      } else {
        cur = newSection();
        cur.pairOld = headPath(line);
        cur.pairNew = headPath(lines[i + 1]!);
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw parseErr(i + 2);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).split('\t')[0]!.trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).split('\t')[0]!.trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw parseErr(1);
  return sections.map((s) => unifiedEdit(s, strict));
}




function srEdit(path, oldLines, newLines, strict) {
  return (tree) => {
    checkSafe(path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, joinFile({ lines: [...newLines], brk: '\n', finalBreak: newLines.length > 0 }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const occ = findOccurrences(f.lines, oldLines, strict);
    if (occ === null) throw new Fail('no-match', path);
    if (occ.at.length > 1) throw new Fail('ambiguous', path);
    const at = occ.at[0];
    const rep = replacement(f.lines, at, oldLines, newLines.map((t) => ({ text: t, ctx: -1 })), occ.tier);
    f.lines.splice(at, oldLines.length, ...rep);
    tree.set(path, joinFile(f));
  };
}

function parseSearchReplace(lines, strict) {
  const edits = [];
  let prevPath = null;
  let bound = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchNo = i + 1;
    let path = null;
    for (let j = i - 1; j >= bound; j -= 1) {
      const l = lines[j]!;
      if (!isBlank(l) && !l.trim().startsWith('```')) {
        path = l.trim();
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw parseErr(searchNo);
    let k = i + 1;
    const oldLines = [];
    while (k < lines.length && lines[k]!.trimEnd() !== '=======') {
      oldLines.push(lines[k]!);
      k += 1;
    }
    if (k >= lines.length) throw parseErr(searchNo);
    k += 1;
    const newLines = [];
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') {
      newLines.push(lines[k]!);
      k += 1;
    }
    if (k >= lines.length) throw parseErr(searchNo);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    bound = k + 1;
    i = k + 1;
  }
  if (edits.length === 0) throw parseErr(1);
  return edits;
}







function vAdd(path, content) {
  return (tree) => {
    checkSafe(path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.set(path, joinFile({ lines: [...content], brk: '\n', finalBreak: content.length > 0 }));
  };
}

function vDelete(path) {
  return (tree) => {
    checkSafe(path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.set(path, null);
  };
}

function vUpdate(path, moveTo, chunks, strict) {
  return (tree) => {
    checkSafe(path);
    if (moveTo !== null) checkSafe(moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findAnchor(f.lines, ch.anchor, cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const o = [];
      const n = [];
      for (const b of ch.body) {
        if (b.kind === ' ') {
          o.push(b.text);
          n.push({ text: b.text, ctx: o.length - 1 });
        } else if (b.kind === '-') {
          o.push(b.text);
        } else {
          n.push({ text: b.text, ctx: -1 });
        }
      }
      if (o.length > 0) {
        const occ = findOccurrences(f.lines, o, strict, cursor, ch.eof);
        if (occ === null) throw new Fail('no-match', path);
        const pos = occ.at[0];
        const rep = replacement(f.lines, pos, o, n, occ.tier);
        f.lines.splice(pos, o.length, ...rep);
        cursor = pos + rep.length;
      } else {
        const at = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        f.lines.splice(at, 0, ...n.map((ln) => ln.text));
        cursor = at + n.length;
      }
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.set(path, null);
      tree.set(moveTo, out);
      tree.moves.push({ from: path, to: moveTo });
    } else {
      tree.set(path, out);
    }
  };
}

function parseV4a(lines, strict) {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw parseErr(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw parseErr(first + 1);
  let last = lines.length - 1;
  while (last > first && isBlank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw parseErr(lines.length + 1);
  const edits = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const content = [];
      let j = i + 1;
      while (j < last && (lines[j]!.startsWith('+') || lines[j] === '')) {
        const l = lines[j]!;
        content.push(l.startsWith('+') ? { text: l.slice(1), empty: false } : { text: '', empty: true });
        j += 1;
      }
      while (content.length > 0 && content[content.length - 1]!.empty) content.pop();
      edits.push(vAdd(path, content.map((c) => c.text)));
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      edits.push(vDelete(line.slice('*** Delete File: '.length).trim()));
      i += 1;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updNo = i + 1;
      let j = i + 1;
      let moveTo = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j += 1;
      }
      const chunks = [];
      let cur = null;
      while (j < last) {
        const l = lines[j]!;
        if (l.startsWith('***')) {
          if (l.trim() === '*** End of File') {
            if (cur === null) {
              cur = { anchor: null, body: [], eof: true };
              chunks.push(cur);
            } else {
              cur.eof = true;
            }
            cur = null;
            j += 1;
            continue;
          }
          break;
        }
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          chunks.push(cur);
          j += 1;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push(l === '' ? { kind: ' ', text: '', empty: true } : { kind: l[0], text: l.slice(1), empty: l.trim() === '' });
          j += 1;
          continue;
        }
        throw parseErr(j + 1);
      }
      while (chunks.length > 0) {
        const tail = chunks[chunks.length - 1]!;
        while (tail.body.length > 0 && tail.body[tail.body.length - 1]!.empty) tail.body.pop();
        if (tail.body.length === 0 && tail.anchor === null && !tail.eof) chunks.pop();
        else break;
      }
      if (chunks.length === 0 && moveTo === null) throw parseErr(updNo);
      edits.push(vUpdate(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw parseErr(i + 1);
  }
  if (edits.length === 0) throw parseErr(1);
  return edits;
}




function jsonEdit(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      checkSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = o.new_str ?? '';
    return (tree) => {
      checkSafe(p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const crlf = splitFile(before).brk === '\r\n';
      const lf = (s) => (crlf ? s.split('\r\n').join('\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.split('\n').join('\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      checkSafe(p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.set(p, joinFile(f));
    };
  }
  return null;
}

function parseJson(text, lines) {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw parseErr(1);
  if (lines[first]!.trimStart().startsWith('[')) {
    let v;
    try {
      v = JSON.parse(text);
    } catch {
      throw parseErr(first + 1);
    }
    if (!Array.isArray(v)) throw parseErr(first + 1);
    const edits = [];
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw parseErr(first + 1);
      edits.push(e);
    }
    if (edits.length === 0) throw parseErr(1);
    return edits;
  }
  const edits = [];
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw parseErr(idx + 1);
    edits.push(e);
  });
  if (edits.length === 0) throw parseErr(1);
  return edits;
}




function detectFormat(lines) {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart().charAt(0);
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.startsWith('diff --git ')) return 'unified';
    if (lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}



const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function run(args) {
  let format = null;
  let checkOnly = false;
  let strict = false;
  const positional = [];
  let optionsDone = false;
  for (const a of args) {
    if (!optionsDone && a === '--') {
      optionsDone = true;
      continue;
    }
    if (!optionsDone && a.length > 1 && a.startsWith('-')) {
      if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (format !== null || !FORMAT_NAMES.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (checkOnly) return { code: 2, out: ['error: usage'] };
        checkOnly = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
      continue;
    }
    positional.push(a);
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };
  const patchArg = positional.length === 0 ? null : positional[0];
  let text;
  if (patchArg === null || patchArg === '-') {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  } else {
    try {
      text = readFileSync(patchArg, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits;
  try {
    if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else if (kind === 'v4a') edits = parseV4a(lines, strict);
    else edits = parseJson(text, lines);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of snapshot) tree.now.set(k, v);
      tree.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows = [];
  const byPath = new Map();
  const byBytes = (x, y) => Buffer.compare(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8'));
  const touched = [...tree.now.keys()].sort(byBytes);
  for (const p of touched) {
    const was = tree.original(p);
    const now = tree.now.get(p);
    if (was === now) continue;
    const row = { key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` };
    rows.push(row);
    byPath.set(p, row);
  }
  const usedFrom = new Set();
  const usedTo = new Set();
  for (const mv of tree.moves) {
    if (usedFrom.has(mv.from) || usedTo.has(mv.to)) continue;
    if (tree.original(mv.from) === null || tree.now.get(mv.from) !== null) continue;
    if (tree.original(mv.to) !== null || tree.now.get(mv.to) === null) continue;
    const dRow = byPath.get(mv.from);
    const aRow = byPath.get(mv.to);
    if (dRow === undefined || aRow === undefined) continue;
    rows.splice(rows.indexOf(dRow), 1);
    rows.splice(rows.indexOf(aRow), 1);
    rows.push({ key: mv.to, line: `R ${mv.from} -> ${mv.to}` });
    usedFrom.add(mv.from);
    usedTo.add(mv.to);
  }
  rows.sort((x, y) => byBytes(x.key, y.key));
  if (!checkOnly) {
    for (const p of touched) {
      const was = tree.original(p);
      const now = tree.now.get(p);
      if (was === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now, 'utf8');
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
