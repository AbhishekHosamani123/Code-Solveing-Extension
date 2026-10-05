// End-to-end test of the exact solve+verify flow used by background.js,
// including the platform note and starter code the content script sends.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

globalThis.self = globalThis;
eval(readFileSync(join(root, 'config.js'), 'utf8'));
const CFG = globalThis.CODESOLVE_CONFIG;
const API_KEY = process.env.GROQ_KEY || CFG.DEFAULT_API_KEY;

const PROBLEM = [
  'Two Sum',
  '',
  'Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.',
  'You may assume that each input would have exactly one solution, and you may not use the same element twice.',
  'You can return the answer in any order.',
  '',
  'Example 1: Input: nums = [2,7,11,15], target = 9. Output: [0,1]. Explanation: nums[0] + nums[1] == 9.',
  'Example 2: Input: nums = [3,2,4], target = 6. Output: [1,2].',
  'Example 3: Input: nums = [3,3], target = 6. Output: [0,1].',
  '',
  'Follow-up: Can you come up with an algorithm that is less than O(n2) time complexity?'
].join('\n');

const STARTER = 'class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:';

function fencedBlocks(text) {
  const out = [];
  const re = /```[^\n`]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    const code = m[1].replace(/^\n+|\n+$/g, '');
    if (code) out.push(code);
  }
  return out;
}
function splitSections(content) {
  const sections = {};
  for (const part of content.split(/^##\s+/m)) {
    const idx = part.indexOf('\n');
    if (idx === -1) continue;
    sections[part.slice(0, idx).trim().toUpperCase()] = part.slice(idx + 1).trim();
  }
  return sections;
}

async function callGroq(model, messages, temperature, maxTokens, effort) {
  const body = { model, messages, temperature, max_completion_tokens: maxTokens };
  if (effort && /gpt-oss/.test(model)) body.reasoning_effort = effort;
  const res = await fetch(`${CFG.GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices[0].message.content || '';
}

const PLATFORM_NOTES = {
  leetcode: 'PLATFORM: LeetCode — the submission must be the exact template shown in the starter code (typically `class Solution` implementing the named method). Do NOT read stdin or print; implement the required method and return the answer.',
};

const platformNote = PLATFORM_NOTES.leetcode;
const t0 = Date.now();
console.log(`[1/3] Solving (${CFG.DEFAULT_MODEL})…`);
const raw1 = await callGroq(
  CFG.DEFAULT_MODEL,
  [
    { role: 'system', content: CFG.SOLVE_SYSTEM_PROMPT },
    { role: 'user', content: `PROBLEM STATEMENT:\n${PROBLEM}\n\nTARGET LANGUAGE: Python 3\n\n${platformNote}\n\nSTARTER CODE (match its signatures / I/O exactly):\n${STARTER}` }
  ],
  0.2, 12000, 'medium'
);
const s1 = splitSections(raw1);
let code = fencedBlocks(s1.CODE || '')[0] || fencedBlocks(raw1)[0] || '';
console.log(`   approach: ${(s1.APPROACH || '').slice(0, 140)}…`);
if (!code) throw new Error('No code parsed from solve response');
console.log(`[1/3] ok — ${code.split('\n').length} lines (${Date.now() - t0}ms)`);

console.log('[2/3] Self-check pass…');
const t1 = Date.now();
const raw2 = await callGroq(
  CFG.DEFAULT_MODEL,
  [
    { role: 'system', content: CFG.VERIFY_SYSTEM_PROMPT },
    { role: 'user', content: `PROBLEM (includes sample input/output examples):\n${PROBLEM}\n\nLANGUAGE: Python 3\n\n${platformNote}\n\nCANDIDATE SOLUTION:\n\`\`\`\n${code}\n\`\`\`\n\nTrace every sample example and check the constraints. Return the required format.` }
  ],
  0, 12000, 'high'
);
const v = splitSections(raw2);
console.log(`   verdict: ${(v.VERDICT || '').split('\n')[0]} (${Date.now() - t1}ms)`);
const vCode = fencedBlocks(v.CODE || '')[0];
if (vCode) code = vCode;

writeFileSync(join(here, 'generated_solution.py'), code);
console.log('[3/3] wrote dev-tests/generated_solution.py — assertions run next');
console.log('\nFULL FLOW OK');
