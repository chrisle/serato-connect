/**
 * Resolve the bl target at MAIN+0xb78d90 dynamically, hook it, and observe.
 * Also hook handler entry to coordinate.
 */

const mod = Process.enumerateModules()[0];
send({tag: 'main', base: mod.base.toString(), size: mod.size});

// Parse instruction at handler's bl call site
const blAddr = mod.base.add(0xb78d90);
const blIns = Instruction.parse(blAddr);
const compTarget = ptr(blIns.operands[0].value);
const compOff = compTarget.sub(mod.base);
send({tag: 'bl_decoded', site: blAddr.toString(), target: compTarget.toString(), target_off: '0x' + compOff.toString(16)});

// Disasm comparator: 200 instructions from its start
function disasmRange(start, count) {
  const lines = [];
  let p = start;
  for (let i = 0; i < count; i++) {
    let ins;
    try { ins = Instruction.parse(p); } catch (e) { lines.push(`?? ${p}: ${e.message}`); break; }
    const off = p.sub(mod.base);
    lines.push(`MAIN+0x${off.toString(16).padStart(8, '0')}  ${ins.mnemonic.padEnd(8)} ${ins.opStr}`);
    p = ins.next;
    if (ins.mnemonic === 'ret') break;
  }
  return lines.join('\n');
}

send({tag: 'disasm_comparator', body: disasmRange(compTarget, 80)});

function readBytes(p, n) {
  try { return Array.from(new Uint8Array(p.readByteArray(n))).map(b => b.toString(16).padStart(2, '0')).join(' '); }
  catch (e) { return null; }
}

// Hook the comparator
let n = 0;
Interceptor.attach(compTarget, {
  onEnter(args) {
    n++;
    this.n = n;
    this.x0 = this.context.x0.toString();
    this.x1 = this.context.x1.toString();
    this.x2 = this.context.x2.toString();
    send({tag: 'CMP_enter', n,
          x0: this.x0, x1: this.x1, x2: this.x2,
          x1_bytes: readBytes(this.context.x1, 32),
          x2_bytes: readBytes(this.context.x2, 32)});
  },
  onLeave(retval) {
    send({tag: 'CMP_leave', n: this.n, retval: retval.toString()});
  }
});
send({tag: 'hooked_comparator'});

let beats = 0;
setInterval(() => { beats++; send({tag: 'beat', n: beats}); }, 5000);
send({tag: 'setup_done'});
