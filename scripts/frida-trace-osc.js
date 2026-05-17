/**
 * Trap C++ exceptions, OSC parser entry, and TCP I/O to figure out
 * why Serato silently rejects our Authorize/Response.
 *
 * Compatible with Frida 17.x API (Module.getGlobalExportByName).
 */

const mod = Process.enumerateModules()[0];
console.log(`MAIN ${mod.name} base=${mod.base}`);

function findStr(s) {
  const pat = Array.from(s).map(c => c.charCodeAt(0).toString(16).padStart(2,'0')).join(' ');
  return Memory.scanSync(mod.base, mod.size, pat);
}

const STR_AUTH_RESP = findStr('/StreamMgmt/Authorize/Response');
const STR_AUTH_REQ  = findStr('/StreamMgmt/Authorize/Request');
const STR_PAIR      = findStr('/StreamMgmt/Pairing/Pair');
console.log(`STR Authorize/Response @ ${STR_AUTH_RESP[0]?.address}`);
console.log(`STR Authorize/Request  @ ${STR_AUTH_REQ[0]?.address}`);
console.log(`STR Pairing/Pair       @ ${STR_PAIR[0]?.address}`);

function tryHook(name, addr, opts) {
  if (!addr) { console.log(`!! no addr for ${name}`); return; }
  try {
    Interceptor.attach(addr, opts);
    console.log(`HOOK ${name} @ ${addr}`);
  } catch (e) {
    console.log(`!! ${name} attach err: ${e.message}`);
  }
}

function getExp(name) {
  try { return Module.getGlobalExportByName(name); }
  catch (_) { return null; }
}

// ---- 1. __cxa_throw — every C++ exception
tryHook('__cxa_throw', getExp('__cxa_throw'), {
  onEnter(args) {
    const tinfo = args[1];
    let typeName = '?';
    try {
      const namePtr = tinfo.add(8).readPointer();
      typeName = namePtr.readCString();
    } catch (e) { typeName = `(read err: ${e.message})`; }
    console.log(`\n*** CXA_THROW type=${typeName}`);
    const bt = Thread.backtrace(this.context, Backtracer.ACCURATE)
      .slice(0, 14)
      .map(a => {
        const sym = DebugSymbol.fromAddress(a);
        const off = a.sub(mod.base);
        return `   ${a}  ${sym.moduleName || '?'}!${sym.name || ''}  off=0x${off.toString(16)}`;
      }).join('\n');
    console.log(bt);
  }
});

// ---- 2. NSException raises (for ObjC throws)
tryHook('objc_exception_throw', getExp('objc_exception_throw'), {
  onEnter(args) {
    const exc = new ObjC.Object(args[0]);
    console.log(`\n*** OBJC_EXC ${exc.toString()}`);
    const bt = Thread.backtrace(this.context, Backtracer.ACCURATE)
      .slice(0, 10)
      .map(a => DebugSymbol.fromAddress(a).toString()).join('\n');
    console.log(bt);
  }
});

// ---- 3. Hook every kernel send path
function hookSyscall(name) {
  tryHook(name, getExp(name), {
    onEnter(args) {
      this.fd = args[0].toInt32();
      this.buf = args[1];
      this.len = args[2].toInt32();
    },
    onLeave(retval) {
      if (this.len < 4 || this.len > 4096) return;
      let b0;
      try { b0 = this.buf.readU8(); } catch (_) { return; }
      let b1, b2, b3;
      try { b1 = this.buf.add(1).readU8(); b2 = this.buf.add(2).readU8(); b3 = this.buf.add(3).readU8(); } catch (_) { return; }
      const isOsc = (b0 === 0x2f) ||
                    (b0 === 0x4c && b1 === 0xaa && b2 === 0xc2 && b3 === 0xae);
      if (!isOsc) return;
      const N = Math.min(this.len, 200);
      let hex = '', ascii = '';
      for (let i = 0; i < N; i++) {
        const x = this.buf.add(i).readU8();
        hex += x.toString(16).padStart(2, '0') + ' ';
        ascii += (x >= 0x20 && x < 0x7f) ? String.fromCharCode(x) : '.';
      }
      console.log(`\n[${name} fd=${this.fd} len=${this.len}] ${ascii}`);
    }
  });
}

['write', 'writev', 'send', 'sendto', 'sendmsg'].forEach(hookSyscall);

// recv-side (different signature for retval, hook separately)
function hookRecv(name) {
  tryHook(name, getExp(name), {
    onEnter(args) {
      this.fd = args[0].toInt32();
      this.buf = args[1];
    },
    onLeave(retval) {
      const n = retval.toInt32();
      if (n < 4 || n > 4096) return;
      let b0;
      try { b0 = this.buf.readU8(); } catch (_) { return; }
      let b1, b2, b3;
      try { b1 = this.buf.add(1).readU8(); b2 = this.buf.add(2).readU8(); b3 = this.buf.add(3).readU8(); } catch (_) { return; }
      const isOsc = (b0 === 0x2f) ||
                    (b0 === 0x4c && b1 === 0xaa && b2 === 0xc2 && b3 === 0xae);
      if (!isOsc) return;
      const N = Math.min(n, 200);
      let ascii = '';
      for (let i = 0; i < N; i++) {
        const x = this.buf.add(i).readU8();
        ascii += (x >= 0x20 && x < 0x7f) ? String.fromCharCode(x) : '.';
      }
      console.log(`\n[${name} fd=${this.fd} len=${n}] ${ascii}`);
    }
  });
}

['read', 'recvfrom', 'recv', 'recvmsg', 'readv'].forEach(hookRecv);

// ---- 4. close() — when control socket gets dropped
tryHook('close', getExp('close'), {
  onEnter(args) {
    this.fd = args[0].toInt32();
  },
  onLeave(retval) {
    // Only log close that returns 0 and fd >= 6 (skip stdio/early)
    if (retval.toInt32() !== 0) return;
    if (this.fd < 6 || this.fd > 200) return;
    console.log(`\n[close fd=${this.fd}]`);
    const bt = Thread.backtrace(this.context, Backtracer.ACCURATE)
      .slice(0, 8)
      .map(a => DebugSymbol.fromAddress(a).toString()).join('\n');
    console.log(bt);
  }
});

// ---- 5. ObjC GCDAsyncSocket delegate hooks
if (ObjC.available) {
  console.log('OBJC: looking for GCDAsyncSocket delegate methods...');
  // Look for Serato-side classes that conform to GCDAsyncSocketDelegate
  const cls = Object.keys(ObjC.classes);
  const delegate = cls.filter(c => /Async|Socket|OSC|Remote/i.test(c)).slice(0, 30);
  console.log('OBJC interesting classes:', delegate.join(', '));
}

console.log('\n=== HOOKS READY ===\n');
