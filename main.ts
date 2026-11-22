// mend: one patch tool for every AI edit format.
// Node 22+ standard library only. See SPEC.md for the contract.
// When MAKEFUN_ENV_URL is set, hand the trial over to runner.ts.

import { readdirSync, readFileSync, rmSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTrial } from './runner.ts';

function exit2(line) {
  process.stdout.write(line + '\n');
  process.exitCode = 2;
}

// ---------------------------------------------------------------------------
// Lines, files, paths
// ---------------------------------------------------------------------------

// A patch's lines: split at \n, one trailing \r removed each, without the
// empty piece after a final \n.
function splitPatchLines(text) {
  const parts = text.split('\n').map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

// new_str's lines (JSON insert): same, but an empty string has no lines.
function splitNewStrLines(text) {
  if (text === '') return [];
  return splitPatchLines(text);
}

function parseFileText(text) {
  if (text === '') return { lines: [], eol: '\n', finalBreak: false };
  const firstLf = text.indexOf('\n');
  const eol = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(eol);
  const parts = text.split(eol);
  if (finalBreak) parts.pop();
  return { lines: parts, eol, finalBreak };
}

function serializeFile(f) {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.eol) + (f.finalBreak ? f.eol : '');
}

function isSafePath(p) {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function trimEndWs(s) {
  return s.replace(/[ \t]+$/, '');
}

function trimWs(s) {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s) {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

// ---------------------------------------------------------------------------
// Matching (section 5)
// ---------------------------------------------------------------------------

function lineEq(a, b, tier) {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

function matchAt(O, lines, pos, tier) {
  for (let j = 0; j < O.length; j++) {
    if (!lineEq(O[j], lines[pos + j], tier)) return false;
  }
  return true;
}

function findOccurrences(O, lines, tier) {
  const out = [];
  for (let i = 0; i + O.length <= lines.length; i++) {
    if (matchAt(O, lines, i, tier)) out.push(i);
  }
  return out;
}

// First tier (0..2, or 0 only when strict) with at least one occurrence.
function findTier(O, lines, strict) {
  const maxT = strict ? 0 : 2;
  for (let t = 0; t <= maxT; t++) {
    const p = findOccurrences(O, lines, t);
    if (p.length > 0) return { tier: t, positions: p };
  }
  return null;
}

// First tier with an occurrence at or after `from`; positions all >= from.
function findTierFrom(O, lines, from, strict) {
  const maxT = strict ? 0 : 2;
  for (let t = 0; t <= maxT; t++) {
    const p = findOccurrences(O, lines, t).filter((x) => x >= from);
    if (p.length > 0) return { tier: t, positions: p };
  }
  return null;
}

// First line at or after `cursor` equal to the anchor (single line) at the
// first tier where one is.
function findAnchor(lines, anchor, cursor, strict) {
  const maxT = strict ? 0 : 2;
  for (let t = 0; t <= maxT; t++) {
    for (let i = cursor; i < lines.length; i++) {
      if (lineEq(anchor, lines[i], t)) return i;
    }
  }
  return -1;
}

// Replace the k matched lines at pos with N. N entries are {text, ctx, oIdx}:
// a context line is written as the file's own matched line; at tier 2 every
// other line of N is re-indented from O's first line to the file's.
function applyReplace(lines, pos, O, N, tier) {
  const F = pos < lines.length ? leadingWs(lines[pos]) : '';
  const P = O.length > 0 ? leadingWs(O[0]) : '';
  const out = lines.slice(0, pos);
  for (const n of N) {
    if (n.ctx) {
      out.push(lines[pos + n.oIdx]);
    } else if (tier === 2 && n.text !== '' && !/^[ \t]*$/.test(n.text) && n.text.startsWith(P)) {
      out.push(F + n.text.slice(P.length));
    } else {
      out.push(n.text);
    }
  }
  out.push(...lines.slice(pos + O.length));
  return out;
}

// Build O (context + old lines) and N (context + new lines) from body lines.
function buildON(body) {
  const O = [];
  const N = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      const idx = O.length;
      O.push(b.text);
      N.push({ text: b.text, ctx: true, oIdx: idx });
    } else if (b.kind === 'old') {
      O.push(b.text);
    } else if (b.kind === 'new') {
      N.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  return { O, N };
}

// Does a `\` line follow the hunk's last context or `+` line?
function backslashAfterLastCtxOrPlus(body) {
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k].kind === 'ctx' || body[k].kind === 'new') {
      return k + 1 < body.length && body[k + 1].kind === 'backslash';
    }
  }
  return false;
}

// Does a `\` line follow the hunk's last `+` line? (created files)
function backslashAfterLastPlus(body) {
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k].kind === 'new') {
      return k + 1 < body.length && body[k + 1].kind === 'backslash';
    }
  }
  return false;
}

// Apply a section's hunks in order to a file's lines.
function applyHunks(file, hunks, strict) {
  let lines = [...file.lines];
  let finalBreak = file.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = buildON(h.body);
    if (O.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const ins = N.map((n) => n.text);
      const atEnd = at === lines.length;
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      if (atEnd) finalBreak = !backslashAfterLastCtxOrPlus(h.body);
      d += N.length;
    } else {
      const found = findTier(O, lines, strict);
      if (!found) return { ok: false, code: 'no-match' };
      const target = h.a - 1 + d;
      let best = found.positions[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const endsAtEof = best + O.length === lines.length;
      lines = applyReplace(lines, best, O, N, found.tier);
      if (endsAtEof) finalBreak = !backslashAfterLastCtxOrPlus(h.body);
      d += N.length - O.length;
    }
  }
  return { ok: true, file: { lines, eol: file.eol, finalBreak } };
}

function fail(code, path) {
  return { ok: false, code, path };
}

function ok() {
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6)
// ---------------------------------------------------------------------------

function parseErr(line) {
  const e = new Error(`parse ${line}`);
  e.line = line;
  return e;
}

function headerPath(line) {
  // Text after the first four characters, up to the first tab, surrounding
  // spaces removed; a leading a/ or b/ is removed.
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseGitLine(line, lineNo) {
  const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  if (!m) throw parseErr(lineNo);
  return { gitOld: m[1], gitNew: m[2] };
}

// Parse one section's header (before its first hunk). Returns the index of
// the first line after the header.
function parseSectionHeader(lines, i, sec) {
  let hasPair = false;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('--- ')) {
      if (i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        if (hasPair) break; // a second pair starts a new section
        sec.oldPath = headerPath(line);
        sec.newPath = headerPath(lines[i + 1]);
        hasPair = true;
        i += 2;
        continue;
      }
      throw parseErr(i + 2); // the line after the `--- ` line
    }
    if (line.startsWith('rename from ')) {
      sec.renameFrom = line.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('rename to ')) {
      sec.renameTo = line.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('new file mode')) {
      sec.create = true;
      i++;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      sec.del = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) break; // first hunk
    if (line.startsWith('diff --git ')) break; // next section
    i++; // index, old/new mode, similarity, Index:, any other line: ignored
  }
  return i;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Parse one section's hunks. Returns the index of the first line after them.
function parseSectionHunks(lines, i, sec) {
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (!m) throw parseErr(i + 1);
      const hunk = { a: Number(m[1]), body: [] };
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
        if (l.startsWith(' ')) {
          hunk.body.push({ kind: 'ctx', text: l.slice(1) });
          j++;
        } else if (l.startsWith('-')) {
          hunk.body.push({ kind: 'old', text: l.slice(1) });
          j++;
        } else if (l.startsWith('+')) {
          hunk.body.push({ kind: 'new', text: l.slice(1) });
          j++;
        } else if (l.startsWith('\\')) {
          hunk.body.push({ kind: 'backslash', text: l.slice(1) });
          j++;
        } else if (l === '') {
          hunk.body.push({ kind: 'ctx', text: '' });
          j++;
        } else {
          break;
        }
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.body.length > 0) {
        const lastB = hunk.body[hunk.body.length - 1];
        if (lastB.kind === 'ctx' && lastB.text === '') hunk.body.pop();
        else break;
      }
      sec.hunks.push(hunk);
      i = j;
      continue;
    }
    if (line.startsWith('diff --git ')) break; // next section
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break; // next section
    i++; // outside bodies, lines that are not part of a header are ignored
  }
  return i;
}

function parseUnified(lines) {
  const edits = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const { gitOld, gitNew } = parseGitLine(line, i + 1);
      const sec = { format: 'unified', gitOld, gitNew, oldPath: null, newPath: null, renameFrom: null, renameTo: null, create: false, del: false, hunks: [] };
      i++;
      i = parseSectionHeader(lines, i, sec);
      i = parseSectionHunks(lines, i, sec);
      edits.push(finishUnifiedSection(sec));
    } else if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const sec = { format: 'unified', gitOld: null, gitNew: null, oldPath: null, newPath: null, renameFrom: null, renameTo: null, create: false, del: false, hunks: [] };
      i = parseSectionHeader(lines, i, sec);
      i = parseSectionHunks(lines, i, sec);
      edits.push(finishUnifiedSection(sec));
    } else if (line.startsWith('@@')) {
      throw parseErr(i + 1); // a hunk before any section
    } else {
      i++; // prose, code fences: ignored
    }
  }
  return edits;
}

function finishUnifiedSection(sec) {
  const oldPath = sec.oldPath ?? sec.renameFrom ?? sec.gitOld ?? '';
  const newPath = sec.newPath ?? sec.renameTo ?? sec.gitNew ?? '';
  const create = sec.create || oldPath === '/dev/null';
  const del = !create && (sec.del || newPath === '/dev/null');
  const move = !create && !del && oldPath !== newPath;
  return { format: 'unified', oldPath, newPath, create, del, move, hunks: sec.hunks };
}

function applyUnified(sec, tree, strict) {
  if (sec.create) {
    if (!isSafePath(sec.newPath)) return fail('unsafe', sec.newPath);
    if (tree.has(sec.newPath)) return fail('exists', sec.newPath);
    const plus = [];
    let lastPlusHunk = null;
    for (const h of sec.hunks) {
      for (const b of h.body) {
        if (b.kind === 'new') {
          plus.push(b.text);
          lastPlusHunk = h;
        }
      }
    }
    const finalBreak = plus.length > 0 && !backslashAfterLastPlus(lastPlusHunk.body);
    tree.set(sec.newPath, { lines: plus, eol: '\n', finalBreak });
    return ok();
  }
  if (sec.del) {
    if (!isSafePath(sec.oldPath)) return fail('unsafe', sec.oldPath);
    if (!tree.has(sec.oldPath)) return fail('missing', sec.oldPath);
    tree.delete(sec.oldPath);
    return ok();
  }
  if (sec.move) {
    if (!isSafePath(sec.oldPath)) return fail('unsafe', sec.oldPath);
    if (!isSafePath(sec.newPath)) return fail('unsafe', sec.newPath);
    if (!tree.has(sec.oldPath)) return fail('missing', sec.oldPath);
    if (tree.has(sec.newPath)) return fail('exists', sec.newPath);
    const res = applyHunks(tree.get(sec.oldPath), sec.hunks, strict);
    if (!res.ok) return fail(res.code, sec.oldPath);
    tree.delete(sec.oldPath);
    tree.set(sec.newPath, res.file);
    return ok();
  }
  const p = sec.oldPath;
  if (!isSafePath(p)) return fail('unsafe', p);
  if (!tree.has(p)) return fail('missing', p);
  const res = applyHunks(tree.get(p), sec.hunks, strict);
  if (!res.ok) return fail(res.code, p);
  tree.set(p, res.file);
  return ok();
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)
// ---------------------------------------------------------------------------

function markerTrimmed(line) {
  return line.replace(/[ \t]+$/, '');
}

function parseSearchReplace(lines) {
  const edits = [];
  let prevEnd = 0;
  let prevPath = null;
  let i = 0;
  while (i < lines.length) {
    if (markerTrimmed(lines[i]) === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const t = lines[j].trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw parseErr(searchLine);
        path = prevPath;
      }
      prevPath = path;
      let eq = -1;
      let k = i + 1;
      while (k < lines.length) {
        const mt = markerTrimmed(lines[k]);
        if (mt === '=======') {
          eq = k;
          break;
        }
        if (mt === '>>>>>>> REPLACE') break;
        k++;
      }
      if (eq === -1) throw parseErr(searchLine);
      let rep = -1;
      let m = eq + 1;
      while (m < lines.length) {
        if (markerTrimmed(lines[m]) === '>>>>>>> REPLACE') {
          rep = m;
          break;
        }
        m++;
      }
      if (rep === -1) throw parseErr(searchLine);
      edits.push({ format: 'sr', path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevEnd = rep + 1;
      i = rep + 1;
    } else {
      i++;
    }
  }
  return edits;
}

function applySearchReplace(edit, tree, strict) {
  if (!isSafePath(edit.path)) return fail('unsafe', edit.path);
  if (edit.oldLines.length === 0) {
    if (tree.has(edit.path)) return fail('exists', edit.path);
    tree.set(edit.path, { lines: [...edit.newLines], eol: '\n', finalBreak: edit.newLines.length > 0 });
    return ok();
  }
  if (!tree.has(edit.path)) return fail('missing', edit.path);
  const f = tree.get(edit.path);
  const found = findTier(edit.oldLines, f.lines, strict);
  if (!found) return fail('no-match', edit.path);
  if (found.positions.length > 1) return fail('ambiguous', edit.path);
  const pos = found.positions[0];
  const N = edit.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
  const lines = applyReplace(f.lines, pos, edit.oldLines, N, found.tier);
  tree.set(edit.path, { lines, eol: f.eol, finalBreak: f.finalBreak });
  return ok();
}

// ---------------------------------------------------------------------------
// V4A patches (section 8)
// ---------------------------------------------------------------------------

function sectionPath(line, prefix) {
  return line.slice(prefix.length).trim();
}

function parseV4a(lines) {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) throw parseErr(1);
  if (lines[first].trim() !== '*** Begin Patch') throw parseErr(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw parseErr(lines.length + 1);

  const edits = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue; // blank lines between sections are ignored
    }
    if (line.startsWith('*** Add File: ')) {
      const path = sectionPath(line, '*** Add File: ');
      i++;
      const fileLines = [];
      while (i < last) {
        const l = lines[i];
        if (l.startsWith('*** ')) break;
        if (l.startsWith('+')) {
          fileLines.push(l.slice(1));
          i++;
        } else if (l === '') {
          fileLines.push('');
          i++;
        } else {
          throw parseErr(i + 1);
        }
      }
      // Blank lines at the end of a section are not part of it.
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push({ format: 'v4a', kind: 'add', path, fileLines });
    } else if (line.startsWith('*** Delete File: ')) {
      const path = sectionPath(line, '*** Delete File: ');
      i++;
      edits.push({ format: 'v4a', kind: 'delete', path });
    } else if (line.startsWith('*** Update File: ')) {
      const path = sectionPath(line, '*** Update File: ');
      const updateLine = i + 1;
      i++;
      let moveTo = null;
      if (i < last && lines[i].startsWith('*** Move to: ')) {
        moveTo = sectionPath(lines[i], '*** Move to: ');
        i++;
      }
      const chunks = [];
      let chunk = null;
      const closeChunk = () => {
        if (chunk) {
          chunks.push(chunk);
          chunk = null;
        }
      };
      while (i < last) {
        const l = lines[i];
        if (l.trim() === '*** End of File') {
          if (!chunk) throw parseErr(i + 1);
          chunk.eof = true;
          closeChunk();
          i++;
          continue;
        }
        if (l.startsWith('*** ')) break; // next section (or a misplaced directive: error below)
        if (l.startsWith('@@')) {
          closeChunk();
          chunk = { anchor: l.slice(2).trim(), eof: false, body: [] };
          i++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (!chunk) chunk = { anchor: null, eof: false, body: [] };
          if (l.startsWith(' ')) chunk.body.push({ kind: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) chunk.body.push({ kind: 'old', text: l.slice(1) });
          else if (l.startsWith('+')) chunk.body.push({ kind: 'new', text: l.slice(1) });
          else chunk.body.push({ kind: 'ctx', text: '' });
          i++;
          continue;
        }
        throw parseErr(i + 1);
      }
      closeChunk();
      // Blank lines at the end of a section are not part of it.
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1];
        while (lastChunk.body.length > 0) {
          const b = lastChunk.body[lastChunk.body.length - 1];
          if (b.kind === 'ctx' && b.text === '') lastChunk.body.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw parseErr(updateLine);
      edits.push({ format: 'v4a', kind: 'update', path, moveTo, chunks });
    } else {
      throw parseErr(i + 1);
    }
  }
  return edits;
}

function applyV4a(edit, tree, strict) {
  if (edit.kind === 'add') {
    if (!isSafePath(edit.path)) return fail('unsafe', edit.path);
    if (tree.has(edit.path)) return fail('exists', edit.path);
    tree.set(edit.path, { lines: [...edit.fileLines], eol: '\n', finalBreak: edit.fileLines.length > 0 });
    return ok();
  }
  if (edit.kind === 'delete') {
    if (!isSafePath(edit.path)) return fail('unsafe', edit.path);
    if (!tree.has(edit.path)) return fail('missing', edit.path);
    tree.delete(edit.path);
    return ok();
  }
  // update
  if (!isSafePath(edit.path)) return fail('unsafe', edit.path);
  if (edit.moveTo !== null && !isSafePath(edit.moveTo)) return fail('unsafe', edit.moveTo);
  if (!tree.has(edit.path)) return fail('missing', edit.path);
  if (edit.moveTo !== null && tree.has(edit.moveTo)) return fail('exists', edit.moveTo);
  const f = tree.get(edit.path);
  let lines = [...f.lines];
  let cursor = 0;
  for (const chunk of edit.chunks) {
    const { O, N } = buildON(chunk.body);
    if (chunk.anchor !== null && chunk.anchor !== '') {
      const a = findAnchor(lines, chunk.anchor, cursor, strict);
      if (a === -1) return fail('no-match', edit.path);
      cursor = a + 1;
    }
    if (O.length === 0) {
      const at = chunk.eof ? lines.length : cursor;
      const ins = N.map((n) => n.text);
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      cursor = at + ins.length;
    } else if (chunk.eof) {
      const p0 = lines.length - O.length;
      let pos = -1;
      let tier = -1;
      if (p0 >= cursor) {
        const maxT = strict ? 0 : 2;
        for (let t = 0; t <= maxT; t++) {
          if (matchAt(O, lines, p0, t)) {
            pos = p0;
            tier = t;
            break;
          }
        }
      }
      if (pos === -1) return fail('no-match', edit.path);
      lines = applyReplace(lines, pos, O, N, tier);
      cursor = pos + N.length;
    } else {
      const found = findTierFrom(O, lines, cursor, strict);
      if (!found) return fail('no-match', edit.path);
      const pos = found.positions[0];
      lines = applyReplace(lines, pos, O, N, found.tier);
      cursor = pos + N.length;
    }
  }
  const nf = { lines, eol: f.eol, finalBreak: f.finalBreak };
  if (edit.moveTo !== null) {
    tree.delete(edit.path);
    tree.set(edit.moveTo, nf);
  } else {
    tree.set(edit.path, nf);
  }
  return ok();
}

// ---------------------------------------------------------------------------
// JSON edits (section 9)
// ---------------------------------------------------------------------------

function parseJsonEdit(obj, errLine) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw parseErr(errLine);
  if (typeof obj.path !== 'string') throw parseErr(errLine);
  switch (obj.command) {
    case 'create':
      if (typeof obj.file_text !== 'string') throw parseErr(errLine);
      return { format: 'json', kind: 'create', path: obj.path, file_text: obj.file_text };
    case 'str_replace': {
      if (typeof obj.old_str !== 'string' || obj.old_str === '') throw parseErr(errLine);
      const newStr = obj.new_str === undefined ? '' : obj.new_str;
      if (typeof newStr !== 'string') throw parseErr(errLine);
      return { format: 'json', kind: 'str_replace', path: obj.path, old_str: obj.old_str, new_str: newStr };
    }
    case 'insert':
      if (typeof obj.insert_line !== 'number' || !Number.isInteger(obj.insert_line)) throw parseErr(errLine);
      if (typeof obj.new_str !== 'string') throw parseErr(errLine);
      return { format: 'json', kind: 'insert', path: obj.path, insert_line: obj.insert_line, new_str: obj.new_str };
    default:
      throw parseErr(errLine);
  }
}

function parseJson(patchText, lines) {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) throw parseErr(1);
  const firstChar = lines[first].trimStart()[0];
  if (firstChar === '[') {
    let arr;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw parseErr(first + 1);
    }
    if (!Array.isArray(arr)) throw parseErr(first + 1);
    return arr.map((obj) => parseJsonEdit(obj, first + 1));
  }
  const edits = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      throw parseErr(i + 1);
    }
    edits.push(parseJsonEdit(obj, i + 1));
  }
  return edits;
}

function countOverlapping(text, sub) {
  let count = 0;
  let first = -1;
  let from = 0;
  while (true) {
    const p = text.indexOf(sub, from);
    if (p === -1) break;
    count++;
    if (first === -1) first = p;
    from = p + 1;
  }
  return { count, first };
}

function applyJson(edit, tree) {
  if (!isSafePath(edit.path)) return fail('unsafe', edit.path);
  if (edit.kind === 'create') {
    if (tree.has(edit.path)) return fail('exists', edit.path);
    tree.set(edit.path, parseFileText(edit.file_text));
    return ok();
  }
  if (!tree.has(edit.path)) return fail('missing', edit.path);
  const f = tree.get(edit.path);
  if (edit.kind === 'str_replace') {
    let text = serializeFile(f);
    let oldS = edit.old_str;
    let newS = edit.new_str;
    const crlf = f.eol === '\r\n';
    if (crlf) {
      text = text.replace(/\r\n/g, '\n');
      oldS = oldS.replace(/\r\n/g, '\n');
      newS = newS.replace(/\r\n/g, '\n');
    }
    const { count, first } = countOverlapping(text, oldS);
    if (count === 0) return fail('no-match', edit.path);
    if (count > 1) return fail('ambiguous', edit.path);
    const replaced = text.slice(0, first) + newS + text.slice(first + oldS.length);
    tree.set(edit.path, parseFileText(crlf ? replaced.replace(/\n/g, '\r\n') : replaced));
    return ok();
  }
  // insert
  if (edit.insert_line < 0 || edit.insert_line > f.lines.length) return fail('no-match', edit.path);
  const ins = splitNewStrLines(edit.new_str);
  const lines = [...f.lines.slice(0, edit.insert_line), ...ins, ...f.lines.slice(edit.insert_line)];
  tree.set(edit.path, { lines, eol: f.eol, finalBreak: f.finalBreak });
  return ok();
}

// ---------------------------------------------------------------------------
// Format detection (section 4) and main
// ---------------------------------------------------------------------------

function detectFormat(lines) {
  let firstNonBlank;
  for (const l of lines) {
    if (l.trim() !== '') {
      firstNonBlank = l;
      break;
    }
  }
  if (firstNonBlank !== undefined && firstNonBlank.trim() === '*** Begin Patch') return 'v4a';
  if (firstNonBlank !== undefined) {
    const c = firstNonBlank.trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  if (lines.some((l) => markerTrimmed(l) === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some((l) => l.startsWith('diff --git ')) ||
    lines.some((l, idx) => l.startsWith('--- ') && idx + 1 < lines.length && lines[idx + 1].startsWith('+++ '))
  ) {
    return 'unified';
  }
  return null;
}

function readTree(dir) {
  const out = new Map();
  const walk = (d, rel) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      const r = rel ? rel + '/' + name : name;
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) out.set(r, readFileSync(p, 'utf8'));
    }
  };
  walk(dir, '');
  return out;
}

function byteCompare(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return Buffer.compare(ba, bb);
}

function main() {
  // ---- arguments (section 1)
  const args = process.argv.slice(2);
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  const positional = [];
  const usage = () => {
    exit2('error: usage');
  };
  for (const a of args) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) return usage();
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return usage();
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) return usage();
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (!['unified', 'search-replace', 'v4a', 'json', 'auto'].includes(v)) return usage();
        format = v;
      } else {
        return usage();
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return usage();

  // ---- read the patch
  const patchArg = positional[0];
  let patchText;
  if (patchArg === undefined || patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      return exit2('error: no-patch');
    }
  }
  const lines = splitPatchLines(patchText);

  // ---- detect the format
  let fmt = format;
  if (fmt === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) return exit2('error: format');
    fmt = detected;
  }

  // ---- parse the whole patch before any file is looked at
  let edits;
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSearchReplace(lines);
    else if (fmt === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(patchText, lines);
    if (edits.length === 0) throw parseErr(1);
  } catch (e) {
    if (e && typeof e.line === 'number') return exit2(`error: parse ${e.line}`);
    throw e;
  }

  // ---- apply the edits in order (section 10)
  const orig = readTree(process.cwd());
  const tree = new Map();
  for (const [p, text] of orig) tree.set(p, parseFileText(text));
  const failures = [];
  const moves = []; // successful move edits, for R lines
  for (const edit of edits) {
    let res;
    if (edit.format === 'unified') res = applyUnified(edit, tree, strict);
    else if (edit.format === 'sr') res = applySearchReplace(edit, tree, strict);
    else if (edit.format === 'v4a') res = applyV4a(edit, tree, strict);
    else res = applyJson(edit, tree);
    if (!res.ok) {
      failures.push(res);
    } else if (edit.format === 'unified' && edit.move) {
      moves.push({ oldPath: edit.oldPath, newPath: edit.newPath });
    } else if (edit.format === 'v4a' && edit.kind === 'update' && edit.moveTo !== null) {
      moves.push({ oldPath: edit.path, newPath: edit.moveTo });
    }
  }

  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += `error: ${f.code} ${f.path}\n`;
    out += `failed: ${failures.length} of ${edits.length} edits\n`;
    process.stdout.write(out);
    process.exitCode = 1;
    return;
  }

  // ---- work out what changed (section 2)
  const after = new Map();
  for (const [p, f] of tree) after.set(p, serializeFile(f));
  const entries = []; // {key, line}
  const byPath = new Map(); // path -> entry, for A/D lines the R merge may replace
  for (const p of new Set([...orig.keys(), ...after.keys()])) {
    const before = orig.has(p) ? orig.get(p) : undefined;
    const aft = after.has(p) ? after.get(p) : undefined;
    if (before === aft) continue;
    let entry;
    if (before === undefined) entry = { key: p, line: `A ${p}` };
    else if (aft === undefined) entry = { key: p, line: `D ${p}` };
    else entry = { key: p, line: `M ${p}` };
    entries.push(entry);
    byPath.set(p, entry);
  }
  // A successful move whose old path existed before and not after, and whose
  // new path did not exist before and does after, replaces that pair's D and
  // A lines with one R line, sorted by the new path.
  for (const m of moves) {
    const beforeOld = orig.has(m.oldPath);
    const afterOld = after.has(m.oldPath);
    const beforeNew = orig.has(m.newPath);
    const afterNew = after.has(m.newPath);
    if (!beforeOld || afterOld || beforeNew || !afterNew) continue;
    const dEntry = byPath.get(m.oldPath);
    const aEntry = byPath.get(m.newPath);
    if (!dEntry || !aEntry || dEntry.line !== `D ${m.oldPath}` || aEntry.line !== `A ${m.newPath}`) continue;
    const di = entries.indexOf(dEntry);
    const ai = entries.indexOf(aEntry);
    if (di === -1 || ai === -1) continue;
    entries.splice(Math.max(di, ai), 1);
    entries.splice(Math.min(di, ai), 1);
    const rEntry = { key: m.newPath, line: `R ${m.oldPath} -> ${m.newPath}` };
    entries.push(rEntry);
    byPath.delete(m.oldPath);
    byPath.delete(m.newPath);
  }
  entries.sort((x, y) => byteCompare(x.key, y.key));

  let out = '';
  for (const e of entries) out += e.line + '\n';
  out += entries.length === 1 ? 'ok: 1 file\n' : `ok: ${entries.length} files\n`;

  if (!check) {
    for (const [p, text] of after) {
      if (orig.get(p) === text) continue;
      const full = join(process.cwd(), ...p.split('/'));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text, 'utf8');
    }
    for (const p of orig.keys()) {
      if (after.has(p)) continue;
      rmSync(join(process.cwd(), ...p.split('/')), { force: true });
    }
  }
  process.stdout.write(out);
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// Entry point (at the end so every declaration above is initialized first)
// ---------------------------------------------------------------------------

if (process.env.MAKEFUN_ENV_URL) {
  runTrial(process.env.MAKEFUN_ENV_URL).then(
    () => { process.exitCode = 0; },
    (err) => { process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`); process.exitCode = 1; },
  );
} else {
  main();
}
