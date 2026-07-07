/**
 * Pure sanity test: hook malloc (fires constantly) and the suspected handler
 * at 0xb78cfc. If malloc fires but handler doesn't, hook mechanism works and
 * the handler genuinely isn't called.
 */

const mod = Process.enumerateModules()[0];
console.log(`MAIN ${mod.name} base=${mod.base}`);

// 1. Find malloc
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
console.log(`malloc @ ${mallocPtr}`);

// 2. Hook malloc with a counter — log only every 10000th call
let mallocCount = 0;
if (mallocPtr) {
  Interceptor.attach(mallocPtr, {
    onEnter() {
      mallocCount++;
      if (mallocCount % 10000 === 0) {
        console.log(`malloc count = ${mallocCount}`);
      }
    }
  });
  console.log('HOOK malloc');
}

// 3. Hook handler
const HANDLER = mod.base.add(0xb78cfc);
Interceptor.attach(HANDLER, {
  onEnter(args) {
    console.log(`\n*** HANDLER FIRED @ 0xb78cfc t=${Date.now()}`);
    console.log(`   x0=${this.context.x0}  x1=${this.context.x1}  x2=${this.context.x2}`);
  }
});
console.log(`HOOK handler @ 0xb78cfc`);

// 4. Also hook the actual function that contains 0xb791ac — the SEND Authorize/Request site.
//    Walk backward from 0xb791ac to find a `sub sp, sp, #N` (function prologue).
//    Hook that prologue address.
function findPrologue(siteOff) {
  for (let k = 0; k < 64; k++) {
    const addr = mod.base.add(siteOff - k * 4);
    let ins;
    try { ins = Instruction.parse(addr); } catch { return null; }
    // arm64 prologue: sub sp, sp, #imm
    if (ins.mnemonic === 'sub' && /sp, sp/.test(ins.opStr)) {
      return addr;
    }
    if (ins.mnemonic === 'stp' && /\[sp, #-/.test(ins.opStr)) {
      return addr;
    }
  }
  return null;
}

const reqPrologue = findPrologue(0xb791ac);
const respPrologue = findPrologue(0xb78f98);

if (reqPrologue) {
  const off = reqPrologue.sub(mod.base);
  Interceptor.attach(reqPrologue, {
    onEnter(args) {
      console.log(`\n*** [REQ-fn prologue] off=0x${off.toString(16)} t=${Date.now()}`);
      console.log(`   x0=${this.context.x0}  x1=${this.context.x1}  x2=${this.context.x2}`);
    }
  });
  console.log(`HOOK Authorize/Request fn prologue @ 0x${off.toString(16)}`);
}

if (respPrologue) {
  const off = respPrologue.sub(mod.base);
  Interceptor.attach(respPrologue, {
    onEnter(args) {
      console.log(`\n*** [RESP-fn prologue] off=0x${off.toString(16)} t=${Date.now()}`);
      console.log(`   x0=${this.context.x0}  x1=${this.context.x1}  x2=${this.context.x2}`);
    }
  });
  console.log(`HOOK Authorize/Response fn prologue @ 0x${off.toString(16)}`);
}

console.log('\n=== HOOKS READY ===\n');

// Heartbeat — confirms script is alive and output is flushed
let beats = 0;
setInterval(() => {
  beats++;
  console.log(`[BEAT ${beats}] mallocCount=${mallocCount} t=${Date.now()}`);
}, 2000);
