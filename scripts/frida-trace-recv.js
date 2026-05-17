/**
 * Trace what Serato does when it receives our Authorize/Response on conn#2.
 *
 * Approach: hook libsystem read/recv (using Process.getModuleByName, the
 * Frida 17 way), filter for OSC bytes (start with '/'), and dump backtrace.
 * Then we can see the call chain from kernel → parser → dispatcher.
 *
 * Also hook both registered handlers (0xb78cfc and 0xb78ea8) so we know
 * if dispatch ever happens.
 */

const mod = Process.enumerateModules()[0];
console.log(`MAIN ${mod.name} base=${mod.base}`);

const HANDLER_RESPONSE = mod.base.add(0xb78cfc);
const HANDLER_STATUS   = mod.base.add(0xb78ea8);

// Frida 17 API: iterate modules to find libsystem and the recv exports
const sysFns = {};
for (const m of Process.enumerateModules()) {
  if (!/libsystem_kernel/.test(m.name)) continue;
  for (const e of m.enumerateExports()) {
    if (['read', 'recv', 'recvfrom', 'recvmsg'].includes(e.name)) {
      sysFns[e.name] = e.address;
      console.log(`  ${e.name} @ ${e.address}`);
    }
  }
  console.log(`libsystem_kernel @ ${m.base}`);
}

function hookHandler(label, addr) {
  Interceptor.attach(addr, {
    onEnter(args) {
      console.log(`\n*** HANDLER FIRED [${label}] off=0x${addr.sub(mod.base).toString(16)} t=${Date.now()}`);
      console.log(`   x0=${this.context.x0}  x1=${this.context.x1}  x2=${this.context.x2}`);
      const bt = Thread.backtrace(this.context, Backtracer.ACCURATE)
        .slice(0, 10)
        .map(a => {
          const o = a.sub(mod.base);
          return `   ${a}  off=0x${o.toString(16)}`;
        }).join('\n');
      console.log(bt);
    }
  });
  console.log(`HOOK handler [${label}] @ 0x${addr.sub(mod.base).toString(16)}`);
}

hookHandler('Authorize/Response', HANDLER_RESPONSE);
hookHandler('StatusChanged',      HANDLER_STATUS);

// Hook each recv-family syscall. iov-based variants put data behind iov[0].iov_base.
function hookRead(name, fnPtr, bufArg) {
  Interceptor.attach(fnPtr, {
    onEnter(args) {
      this.name = name;
      this.fd = args[0].toInt32();
      this.bufArg = args[bufArg];
    },
    onLeave(retval) {
      const n = retval.toInt32();
      if (n <= 0) return;
      let buf = this.bufArg;
      // For recvmsg, args[1] is msghdr*; we need msg_iov[0].iov_base.
      if (this.name === 'recvmsg') {
        try {
          const msgIov = buf.add(0x10).readPointer();   // msghdr.msg_iov
          buf = msgIov.readPointer();                   // iovec.iov_base
        } catch { return; }
      }
      let head;
      try { head = buf.readU8(); } catch { return; }
      if (head !== 0x2f) return;  // not '/'
      let bytes;
      try { bytes = buf.readByteArray(Math.min(n, 80)); } catch { return; }
      const u8 = new Uint8Array(bytes);
      const ascii = Array.from(u8).map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('');
      const path = ascii.split('\0')[0];
      if (!/^\/StreamMgmt/.test(path)) return;
      console.log(`\n>> ${this.name} fd=${this.fd} n=${n} path=${path}`);
      const bt = Thread.backtrace(this.context, Backtracer.ACCURATE)
        .slice(0, 18)
        .map(a => {
          const o = a.sub(mod.base);
          const inMod = a.compare(mod.base) >= 0 && a.compare(mod.base.add(mod.size)) < 0;
          return inMod ? `   MAIN+0x${o.toString(16)}` : `   ${a}`;
        }).join('\n');
      console.log(bt);
    }
  });
  console.log(`HOOK ${name} @ ${fnPtr}`);
}

if (sysFns.read)     hookRead('read',     sysFns.read,     1);
if (sysFns.recv)     hookRead('recv',     sysFns.recv,     1);
if (sysFns.recvfrom) hookRead('recvfrom', sysFns.recvfrom, 1);
if (sysFns.recvmsg)  hookRead('recvmsg',  sysFns.recvmsg,  1);

console.log('\n=== HOOKS READY ===\n');
