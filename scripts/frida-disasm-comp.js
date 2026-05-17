/**
 * Disassemble the comparator at MAIN+0xa3cc4c (called by handler at 0xb78d90).
 */

const mod = Process.enumerateModules()[0];
send({tag: 'main', base: mod.base.toString()});

function disasm(start, end) {
  const lines = [];
  let p = start;
  while (p.compare(end) < 0) {
    let ins;
    try { ins = Instruction.parse(p); } catch (e) { lines.push(`?? ${p}: ${e.message}`); break; }
    const off = p.sub(mod.base);
    lines.push(`MAIN+0x${off.toString(16).padStart(8, '0')}  ${ins.mnemonic.padEnd(8)} ${ins.opStr}`);
    p = ins.next;
    if (lines.length > 300) { lines.push('TRUNC'); break; }
  }
  return lines.join('\n');
}

const compStart = mod.base.add(0xa3cc4c);
send({tag: 'disasm_comparator', body: disasm(compStart, compStart.add(0x300))});

// Also disasm the sender for Authorize/Request to find where entries get added
const sendStart = mod.base.add(0xb791ac);
send({tag: 'disasm_sender_AuthReq', body: disasm(sendStart, sendStart.add(0x300))});

setTimeout(() => {}, 5000);
