// mend — one patch tool for the four edit formats AI models write: unified
// diffs, SEARCH/REPLACE blocks, V4A patches and JSON text-editor tool calls.
// It finds the lines an edit names at the first of three whitespace-tolerant
// matching tiers, and changes every file or none. Written from SPEC.md
// (version 1), which is the whole contract; section numbers below are its.
// Node 22, the standard library alone, deterministic.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------- errors

/** An exit-2 outcome (SPEC 2): the one line to print. */
class Exit2 extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit failed, with a SPEC 2 code at the path the failure concerns. */
class Fail extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const parseErr = (n: number): Exit2 => new Exit2(`error: parse ${n}`);

// ---------------------------------------------------------------- text

const isBlank = (s: string): boolean => s.trim() === '';

/** SPEC 3: a patch's lines — split at \n, one trailing \r removed from each,
 * and no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC 3: a safe path is non-empty, relative, backslash-free, and has no
 * empty, `.` or `..` segment. */
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function checkSafe(p: string): void {
  if (!safePath(p)) throw new Fail('unsafe', p);
}

// ---------------------------------------------------------------- files

/** A file as lines: its own line break, and whether it ends with one. */
interface FileLines {
  lines: string[];
  brk: string;
  finalBreak: boolean;
}

/** SPEC 3: a file's break is CRLF when its first line feed follows a CR. */
function splitFile(text: string): FileLines {
  const nl = text.indexOf('\n');
  const brk = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], brk, finalBreak: false };
  const lines = text.split(brk);
  const finalBreak = text.endsWith(brk);
  if (finalBreak) lines.pop();
  return { lines, brk, finalBreak };
}

/** SPEC 3: a file of no lines is written empty. */
function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.finalBreak ? f.brk : '');
}

// ---------------------------------------------------------------- tree

/** The tree as the edits leave it: `now` holds every path an edit has set
 * (null: deleted); anything else is read from disk, once. */
class Tree {
  private readonly origCache = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { from: string; to: string }[] = [];

  original(p: string): string | null {
    if (!this.origCache.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.origCache.set(p, v);
    }
    return this.origCache.get(p) as string | null;
  }

  get(p: string): string | null {
    if (this.now.has(p)) return this.now.get(p) as string | null;
    return this.original(p);
  }

  set(p: string, text: string | null): void {
    this.now.set(p, text);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------- SPEC 5

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0] as string;

const tierNorm = (tier: number): ((s: string) => string) =>
  tier === 0 ? (s: string) => s : tier === 1 ? trimTrail : trimBoth;

interface Occurrence {
  tier: number;
  at: number[];
}

/** Every start position of O in lines at the first tier that has one,
 * counting only positions at or after `from` (and, when `mustEnd`, only
 * occurrences that end at the file's last line). */
function findOccurrences(lines: string[], o: string[], strict: boolean, from = 0, mustEnd = false): Occurrence | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const norm = tierNorm(tier);
    const want = o.map(norm);
    const at: number[] = [];
    for (let i = from; i + o.length <= lines.length; i += 1) {
      if (mustEnd && i + o.length !== lines.length) continue;
      let ok = true;
      for (let k = 0; k < o.length; k += 1) {
        if (norm(lines[i + k] as string) !== want[k]) {
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

/** The first line at or after `from` equal to a single-line anchor, at the
 * first tier that has one (SPEC 8). */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const norm = tierNorm(tier);
    const want = norm(anchor);
    for (let i = from; i < lines.length; i += 1) {
      if (norm(lines[i] as string) === want) return i;
    }
  }
  return null;
}

/** One line of N: its text, and for a context line the index of the line of
 * O it stands for (-1: a line the patch adds). */
interface NLine {
  text: string;
  ctx: number;
}

/** SPEC 5: the lines that replace a match — a context line is written as the
 * file's own matched line; at tier 2 every other line is re-indented from
 * O's first line's indentation to the file's. */
function replacement(fileLines: string[], at: number, o: string[], n: NLine[], tier: number): string[] {
  const f = tier === 2 ? leadWs(fileLines[at] as string) : '';
  const p = tier === 2 ? leadWs(o[0] as string) : '';
  return n.map((ln) => {
    if (ln.ctx >= 0) return fileLines[at + ln.ctx] as string;
    if (tier === 2 && ln.text.trim() !== '' && ln.text.startsWith(p)) return f + ln.text.slice(p.length);
    return ln.text;
  });
}

// ---------------------------------------------------------------- SPEC 6

interface BodyLine {
  kind: string; // ' ', '-', '+' or '\\'
  text: string;
  empty: boolean; // the patch line was exactly ''
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  pairOld?: string | null; // undefined: no --- line; null: /dev/null
  pairNew?: string | null;
  diffOld?: string;
  diffNew?: string;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return { newFile: false, delFile: false, hunks: [] };
}

/** A --- or +++ path: after the four characters, up to the first tab, with
 * surrounding spaces removed; /dev/null is no file; a leading a/ or b/ goes. */
function headPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** The paths of a `diff --git a/<X> b/<Y>` line, or a parse error. */
function diffGitPaths(line: string, lineNo: number): { x: string; y: string } {
  const m = /^a\/(.+) b\/(.+)$/.exec(line.slice('diff --git '.length));
  if (m === null) throw parseErr(lineNo);
  return { x: m[1] as string, y: m[2] as string };
}

/** Apply one section's hunks in order to a file's lines (SPEC 6). */
function applyHunks(f: FileLines, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    const n: NLine[] = [];
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
    // Does a `\` line follow the hunk's last context or `+` line?
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
      let best = occ.at[0] as number;
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

/** One unified section as an edit (SPEC 6). */
function unifiedEdit(s: Section, strict: boolean): Edit {
  let oldP: string | null;
  let newP: string | null;
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
      const target = newP as string;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const content: string[] = [];
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
    const source = oldP as string;
    const before = tree.get(source);
    if (before === null) throw new Fail('missing', source);
    if (isDelete) {
      tree.set(source, null);
      return;
    }
    const dest = newP as string;
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

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const pairAt = (i: number): boolean =>
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
      cur.hunks.push({ a: parseInt(m[1] as string, 10), body });
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
      // The section's header, before its first hunk.
      if (line.startsWith('--- ')) throw parseErr(i + 2);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).split('\t')[0]!.trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).split('\t')[0]!.trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1; // prose outside sections and bodies is ignored
  }
  if (sections.length === 0) throw parseErr(1);
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---------------------------------------------------------------- SPEC 7

/** One SEARCH/REPLACE block as an edit. */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
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
    const at = occ.at[0] as number;
    const rep = replacement(f.lines, at, oldLines, newLines.map((t) => ({ text: t, ctx: -1 })), occ.tier);
    f.lines.splice(at, oldLines.length, ...rep);
    tree.set(path, joinFile(f));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let bound = 0; // a block's path line sits after the previous block's REPLACE line
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchNo = i + 1;
    let path: string | null = null;
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
    const oldLines: string[] = [];
    while (k < lines.length && lines[k]!.trimEnd() !== '=======') {
      oldLines.push(lines[k]!);
      k += 1;
    }
    if (k >= lines.length) throw parseErr(searchNo);
    k += 1;
    const newLines: string[] = [];
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

// ---------------------------------------------------------------- SPEC 8

interface VBodyLine {
  kind: string; // ' ', '-' or '+'
  text: string;
  empty: boolean; // the patch line was exactly ''
}

interface VChunk {
  anchor: string | null;
  body: VBodyLine[];
  eof: boolean;
}

function vAdd(path: string, content: string[]): Edit {
  return (tree) => {
    checkSafe(path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.set(path, joinFile({ lines: [...content], brk: '\n', finalBreak: content.length > 0 }));
  };
}

function vDelete(path: string): Edit {
  return (tree) => {
    checkSafe(path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.set(path, null);
  };
}

function vUpdate(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
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
      const o: string[] = [];
      const n: NLine[] = [];
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
        const pos = occ.at[0] as number;
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

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw parseErr(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw parseErr(first + 1);
  let last = lines.length - 1;
  while (last > first && isBlank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw parseErr(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const content: { text: string; empty: boolean }[] = [];
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
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
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
          cur.body.push(l === '' ? { kind: ' ', text: '', empty: true } : { kind: l[0] as string, text: l.slice(1), empty: l.trim() === '' });
          j += 1;
          continue;
        }
        throw parseErr(j + 1);
      }
      // Blank lines at the end of the section are not part of it.
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

// ---------------------------------------------------------------- SPEC 9

/** One JSON edit object, or null when it is not one (SPEC 9). */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
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
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      checkSafe(p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      // In a CRLF file the text and both strings are read with \r\n as \n,
      // and the result is written back with \r\n. The match is exact.
      const crlf = splitFile(before).brk === '\r\n';
      const lf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
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

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw parseErr(1);
  if (lines[first]!.trimStart().startsWith('[')) {
    // One JSON array: any fault is named by the line where the array starts.
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw parseErr(first + 1);
    }
    if (!Array.isArray(v)) throw parseErr(first + 1);
    const edits: Edit[] = [];
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw parseErr(first + 1);
      edits.push(e);
    }
    if (edits.length === 0) throw parseErr(1);
    return edits;
  }
  // JSON Lines: one edit object a line, blank lines ignored.
  const edits: Edit[] = [];
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
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

// ---------------------------------------------------------------- SPEC 4

/** Format detection with --format=auto, in the order SPEC 4 names. */
function detectFormat(lines: string[]): string | null {
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

// ---------------------------------------------------------------- SPEC 1, 2, 10

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
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
  const patchArg = positional.length === 0 ? null : (positional[0] as string);
  let text: string;
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
  let edits: Edit[];
  try {
    if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else if (kind === 'v4a') edits = parseV4a(lines, strict);
    else edits = parseJson(text, lines);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  // SPEC 10: edits apply in order to the tree as earlier edits left it; a
  // failed edit changes nothing, and the ones after it still run.
  const tree = new Tree();
  const fails: Fail[] = [];
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
  // SPEC 2: one line per changed path, in UTF-8 byte order; a successful
  // move replaces its D and A lines with one R line that sorts by the new path.
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const byPath = new Map<string, Row>();
  const byBytes = (x: string, y: string): number => Buffer.compare(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8'));
  const touched = [...tree.now.keys()].sort(byBytes);
  for (const p of touched) {
    const was = tree.original(p);
    const now = tree.now.get(p) as string | null;
    if (was === now) continue;
    const row: Row = { key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` };
    rows.push(row);
    byPath.set(p, row);
  }
  const usedFrom = new Set<string>();
  const usedTo = new Set<string>();
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
      const now = tree.now.get(p) as string | null;
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
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
