// Standalone sanity test for the content.js syntax highlighter logic.
// Extracted verbatim (minus DOM calls) — asserts text preservation + classes.
import assert from 'node:assert';

const HL_KEYWORDS = {
  python: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case self print'.split(' '),
  clike: ('abstract as base bool break byte case catch char class const constructor continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach get goto if implicit in int interface internal is lock long namespace new null object operator out override params partial private protected public readonly record ref return sbyte sealed set short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using value var virtual void volatile where while').split(' '),
  js: 'async await break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while with yield'.split(' '),
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false make new len cap append copy delete panic recover'.split(' '),
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'
};
HL_KEYWORDS.rust = HL_KEYWORDS.rust.split(' ');

function hlKeywordSet(lang) {
  const l = String(lang || '').toLowerCase();
  if (/py|python/.test(l)) return new Set(HL_KEYWORDS.python);
  if (/js|javascript|ts|typescript|json/.test(l)) return new Set(HL_KEYWORDS.js);
  if (/go|golang/.test(l)) return new Set(HL_KEYWORDS.go);
  if (/rust|^rs$/.test(l)) return new Set(HL_KEYWORDS.rust);
  if (/c\+\+|cpp|c#|csharp|java|(^|\s)c(\s|$)/.test(l)) return new Set(HL_KEYWORDS.clike);
  return new Set([...HL_KEYWORDS.clike, ...HL_KEYWORDS.js]);
}

const HL_TOKEN_RE = /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\.|[^`\\])*`?|\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|\b\d[\w.]*\b|\b[A-Za-z_]\w*\b)/g;

function highlight(code, lang) {
  const kw = hlKeywordSet(lang);
  const out = [];
  let last = 0, m;
  HL_TOKEN_RE.lastIndex = 0;
  while ((m = HL_TOKEN_RE.exec(code))) {
    if (m.index > last) out.push([null, code.slice(last, m.index)]);
    const tok = m[0];
    const c = tok[0];
    let cls = null;
    if (c === '"' || c === "'" || c === '`') cls = 'tok-str';
    else if (tok.startsWith('//') || tok.startsWith('/*') || tok.startsWith('#')) cls = 'tok-com';
    else if (/\d/.test(c)) cls = 'tok-num';
    else if (kw.has(tok)) cls = 'tok-kw';
    else if (code[m.index + tok.length] === '(') cls = 'tok-fn';
    out.push([cls, tok]);
    last = m.index + tok.length;
  }
  if (last < code.length) out.push([null, code.slice(last)]);
  return out;
}

function run(name, code, lang, expect) {
  const parts = highlight(code, lang);
  const rebuilt = parts.map(p => p[1]).join('');
  assert.strictEqual(rebuilt, code, `${name}: tokenization must preserve text exactly`);
  for (const [needle, cls] of expect) {
    const hit = parts.find(p => p[0] === cls && p[1].includes(needle));
    assert.ok(hit, `${name}: expected a ${cls} token containing ${JSON.stringify(needle)}`);
  }
  // No token may contain a newline EXCEPT multi-line strings/comments —
  // visual sanity: identifiers/keywords/numbers are single-line tokens.
  for (const [cls, tok] of parts) {
    if (cls && cls !== 'tok-str' && cls !== 'tok-com') {
      assert.ok(!tok.includes('\n'), `${name}: ${cls} token spans a newline: ${JSON.stringify(tok)}`);
    }
  }
  console.log('PASS', name);
}

run('python', 'def twoSum(nums, target):\n    # find the pair\n    seen = {}\n    for i, x in enumerate(nums):\n        if target - x in seen:  # it\'s here\n            return [seen[target - x], i]\n        seen[x] = i\n    return []', 'python', [
  ['def', 'tok-kw'], ['twoSum', 'tok-fn'], ['# find the pair', 'tok-com'],
]);
run('cpp', '#include <bits/stdc++.h>\nusing namespace std;\n// main entry\nint main() {\n  string s = "hello /* not a comment */";\n  int x = 42;\n  cout << s << x;\n  return 0;\n}', 'cpp', [
  ['int', 'tok-kw'], ['#include <bits/stdc++.h>', 'tok-com'], ['main', 'tok-fn'], ['"hello /* not a comment */"', 'tok-str'], ['42', 'tok-num'],
]);
run('js', 'const f = async (n) => {\n  /* block */\n  let s = `tpl ${n}`;\n  return s.length; // done\n};\nfoo(n);', 'javascript', [
  ['const', 'tok-kw'], ['async', 'tok-kw'], ['/* block */', 'tok-com'], ['foo', 'tok-fn'],
]);
run('streaming-unterminated-string', 'def f():\n    return "abc', 'python', [
  ['def', 'tok-kw'], ['"abc', 'tok-str'],
]);
run('apostrophe-inside-comment', "// don't worry — it's fine\nx = 1", 'javascript', [
  ["// don't worry — it's fine", 'tok-com'],
]);
run('python-numbers', 'x = 0x1F + 3.14\nif x > 10: pass', 'python', [
  ['0x1F', 'tok-num'], ['3.14', 'tok-num'], ['if', 'tok-kw'], ['pass', 'tok-kw'],
]);

console.log('All highlighter tests passed.');
