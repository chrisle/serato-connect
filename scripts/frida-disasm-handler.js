/**
 * Disassemble the Authorize/Response handler at 0xb78cfc.
 * Look for: branches, calls, and data refs to understand what blocks return.
 *
 * Range: 0xb78cfc to 0xb78ea8 (start of next handler).
 */

const mod = Process.enumerateModules()[0];
const start = mod.base.add(0xb78cfc);
const end = mod.base.add(0xb78ea8);
let p = start;
const lines = [];
while (p.compare(end) < 0) {
  let ins;
  try { ins = Instruction.parse(p); } catch (e) { lines.push(`?? ${p}: ${e.message}`); break; }
  const off = p.sub(mod.base);
  lines.push(`MAIN+0x${off.toString(16).padStart(8, '0')}  ${ins.mnemonic.padEnd(8)} ${ins.opStr}`);
  p = ins.next;
  if (lines.length > 200) { lines.push('TRUNC'); break; }
}
send({tag: 'disasm', count: lines.length, body: lines.join('\n')});

setTimeout(() => {}, 30000);
