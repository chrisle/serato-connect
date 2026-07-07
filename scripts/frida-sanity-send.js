/**
 * Minimal sanity test using send() (not console.log) for output.
 * Hooks malloc with explicit send() + ALSO tries Interceptor.replace.
 * If even one channel fires, Frida hooking works.
 */

send({tag: 'init', t: Date.now(), modules: Process.enumerateModules().length});

let mod = Process.enumerateModules()[0];
send({tag: 'main_module', name: mod.name, base: mod.base.toString()});

// Find malloc
let mallocPtr = null;
for (const m of Process.enumerateModules()) {
  if (!/libsystem_malloc/.test(m.name)) continue;
  for (const e of m.enumerateExports()) {
    if (e.name === 'malloc') {
      mallocPtr = e.address;
      break;
    }
  }
}
send({tag: 'malloc_found', addr: mallocPtr ? mallocPtr.toString() : null});

if (mallocPtr) {
  let n = 0;
  Interceptor.attach(mallocPtr, {
    onEnter() {
      n++;
      if (n === 1 || n === 100 || n === 10000) {
        send({tag: 'malloc_hit', n: n, t: Date.now()});
      }
    }
  });
  send({tag: 'malloc_hooked'});
}

// Hook Serato target handler
const HANDLER = mod.base.add(0xb78cfc);
let hCount = 0;
Interceptor.attach(HANDLER, {
  onEnter(args) {
    hCount++;
    send({tag: 'handler_hit', n: hCount, t: Date.now(),
          x0: this.context.x0.toString(),
          x1: this.context.x1.toString(),
          x2: this.context.x2.toString()});
  }
});
send({tag: 'handler_hooked', off: '0xb78cfc'});

// Hook the prologue of the actual function CONTAINING handler 0xb78cfc.
// Walk back from 0xb78cfc to find the function start.
function findPrologue(siteOff) {
  for (let k = 0; k < 64; k++) {
    const addr = mod.base.add(siteOff - k * 4);
    let ins;
    try { ins = Instruction.parse(addr); } catch { return null; }
    if (ins.mnemonic === 'sub' && /sp, sp/.test(ins.opStr)) return addr;
    if (ins.mnemonic === 'stp' && /\[sp, #-/.test(ins.opStr)) return addr;
  }
  return null;
}
const handlerProl = findPrologue(0xb78cfc + 4);  // search from siteoff
if (handlerProl) {
  const off = handlerProl.sub(mod.base);
  let pCount = 0;
  Interceptor.attach(handlerProl, {
    onEnter(args) {
      pCount++;
      send({tag: 'handler_prol_hit', n: pCount, off: '0x' + off.toString(16), t: Date.now()});
    }
  });
  send({tag: 'handler_prol_hooked', off: '0x' + off.toString(16)});
}

// Heartbeat via send (will pump even if console.log is broken)
let beats = 0;
setInterval(() => {
  beats++;
  send({tag: 'beat', n: beats, t: Date.now()});
}, 2000);

send({tag: 'setup_done'});
