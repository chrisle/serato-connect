/**
 * Capture full content of fatal-level MessagePack logs Serato writes to fd=4.
 * Time-correlate with AUTH_RESP_HANDLER firing.
 * Hook the handler's caller (MAIN+0xb781a4) so we see when (or if) it returns.
 */

const mod = Process.enumerateModules()[0];
send({tag: 'main', name: mod.name, base: mod.base.toString()});

function readBytes(p, n) {
  try { return Array.from(new Uint8Array(p.readByteArray(n))).map(b => b.toString(16).padStart(2, '0')).join(' '); }
  catch (e) { return null; }
}
function readUtf8(p, n) {
  try { return p.readUtf8String(n); } catch(e) { return null; }
}

// Hook AUTH_RESP_HANDLER, with both enter and leave
{
  const HANDLER = mod.base.add(0xb78cfc);
  let n = 0;
  Interceptor.attach(HANDLER, {
    onEnter(args) {
      n++;
      this.n = n;
      this.entered = Date.now();
      send({tag: 'HANDLER_enter', n, t: this.entered});
    },
    onLeave(retval) {
      send({tag: 'HANDLER_leave', n: this.n, dur_ms: Date.now() - this.entered, retval: retval.toString()});
    }
  });
}

// Hook the handler's CALLER (MAIN+0xb781a4) — find function prologue first.
function findPrologue(siteOff) {
  for (let k = 0; k < 256; k++) {
    const addr = mod.base.add(siteOff - k * 4);
    let ins;
    try { ins = Instruction.parse(addr); } catch { return null; }
    if (ins.mnemonic === 'sub' && /sp, sp/.test(ins.opStr)) return addr;
    if (ins.mnemonic === 'stp' && /\[sp, #-/.test(ins.opStr)) return addr;
  }
  return null;
}
const callerProl = findPrologue(0xb781a4);
if (callerProl) {
  const off = callerProl.sub(mod.base);
  let n = 0;
  Interceptor.attach(callerProl, {
    onEnter() { n++; this.n = n; this.t = Date.now(); send({tag: 'CALLER_enter', n, t: this.t, off: '0x'+off.toString(16)}); },
    onLeave(rv) { send({tag: 'CALLER_leave', n: this.n, dur: Date.now() - this.t, retval: rv.toString()}); }
  });
  send({tag: 'hooked_caller', off: '0x'+off.toString(16)});
}

// Hook write/sendto to capture FULL fatal logs (not just preview)
const kernel = Process.enumerateModules().find(m => /libsystem_kernel/.test(m.name));
if (kernel) {
  for (const name of ['write', '__write_nocancel', '__sendto', 'sendto']) {
    const exp = kernel.enumerateExports().find(e => e.name === name);
    if (!exp) continue;
    let n = 0;
    Interceptor.attach(exp.address, {
      onEnter() {
        n++;
        const fd = this.context.x0.toInt32();
        const bufP = this.context.x1;
        const len = this.context.x2.toInt32();
        // Only capture fd=4 writes that begin with MessagePack fixmap (0x88..0x8f)
        try {
          const first = bufP.readU8();
          if (fd === 4 && first >= 0x80 && first <= 0xbf && len > 50 && len < 600) {
            // Looks like a MessagePack message — capture full contents
            send({tag: 'FATAL_LOG', fn: name, n, fd, len, t: Date.now(),
                  full: readBytes(bufP, Math.min(len, 512))});
          }
        } catch(e){}
      }
    });
  }
}

let beats = 0;
setInterval(() => {
  beats++;
  send({tag: 'beat', n: beats, t: Date.now()});
}, 5000);

send({tag: 'setup_done'});
