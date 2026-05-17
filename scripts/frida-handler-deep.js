/**
 * Deep inspection of the Authorize/Response handler at 0xb78cfc.
 * Logs args, retval, backtrace, and reads memory at arg pointers.
 *
 * Also hooks:
 *  - send/write on libsystem_kernel to catch any outbound msg the handler triggers
 *  - 0xb78ea8 (StatusChanged handler)
 *  - SENDER functions 0xb791ac (Authorize/Request) and 0xb79260 (Pair)
 */

const mod = Process.enumerateModules()[0];
send({tag: 'main', name: mod.name, base: mod.base.toString()});

function readBytes(p, n) {
  try { return Array.from(new Uint8Array(p.readByteArray(n))).map(b => b.toString(16).padStart(2, '0')).join(' '); }
  catch (e) { return 'READ_ERR ' + e.message; }
}

function bt(ctx, n) {
  return Thread.backtrace(ctx, Backtracer.ACCURATE).slice(0, n).map(a => {
    const o = a.sub(mod.base);
    const inMod = a.compare(mod.base) >= 0 && a.compare(mod.base.add(mod.size)) < 0;
    return inMod ? 'MAIN+0x' + o.toString(16) : a.toString();
  });
}

// Authorize/Response handler @ 0xb78cfc
{
  const HANDLER = mod.base.add(0xb78cfc);
  let n = 0;
  Interceptor.attach(HANDLER, {
    onEnter(args) {
      n++;
      this.n = n;
      this.entered = Date.now();
      send({tag: 'AUTH_RESP_HANDLER_enter', n: n, t: this.entered,
            x0: this.context.x0.toString(),
            x1: this.context.x1.toString(),
            x2: this.context.x2.toString(),
            x3: this.context.x3.toString(),
            x4: this.context.x4.toString(),
            x5: this.context.x5.toString(),
            backtrace: bt(this.context, 10)});
      // Sample memory at arg pointers (OSC message blob is likely accessible via one of them)
      try { send({tag: 'AUTH_RESP_HANDLER_mem_x1', bytes: readBytes(this.context.x1, 64)}); } catch(e){}
      try { send({tag: 'AUTH_RESP_HANDLER_mem_x2', bytes: readBytes(this.context.x2, 64)}); } catch(e){}
      try { send({tag: 'AUTH_RESP_HANDLER_mem_x0_deref', x0p: ptr(this.context.x0).readPointer().toString()}); } catch(e){}
    },
    onLeave(retval) {
      send({tag: 'AUTH_RESP_HANDLER_leave', n: this.n,
            dur_ms: Date.now() - this.entered,
            retval: retval.toString(),
            x0: this.context.x0.toString()});
    }
  });
  send({tag: 'hooked_AuthRespHandler', off: '0xb78cfc'});
}

// StatusChanged handler @ 0xb78ea8
{
  const HANDLER = mod.base.add(0xb78ea8);
  let n = 0;
  Interceptor.attach(HANDLER, {
    onEnter(args) {
      n++;
      send({tag: 'STATUS_HANDLER', n: n, t: Date.now(),
            x0: this.context.x0.toString(),
            x1: this.context.x1.toString(),
            x2: this.context.x2.toString()});
    }
  });
  send({tag: 'hooked_StatusHandler', off: '0xb78ea8'});
}

// SEND syscalls — anything written to a socket
const kernel = Process.enumerateModules().find(m => /libsystem_kernel/.test(m.name));
if (kernel) {
  for (const name of ['__sendto', '__sendmsg', 'sendto', 'sendmsg', 'send', '__write_nocancel', 'write']) {
    const exp = kernel.enumerateExports().find(e => e.name === name);
    if (!exp) continue;
    let n = 0;
    try {
      Interceptor.attach(exp.address, {
        onEnter(args) {
          n++;
          if (n <= 30) {
            const fd = this.context.x0.toInt32();
            const bufP = this.context.x1;
            const len = this.context.x2.toInt32();
            let preview = '';
            try { preview = readBytes(bufP, Math.min(len, 32)); } catch(e){}
            send({tag: 'KSEND', fn: name, n: n, fd: fd, len: len, preview: preview});
          }
        }
      });
      send({tag: 'hooked_kernel', fn: name, addr: exp.address.toString()});
    } catch(e) {
      send({tag: 'kernel_hook_err', fn: name, err: e.message});
    }
  }
}

// Heartbeat
let beats = 0;
setInterval(() => {
  beats++;
  send({tag: 'beat', n: beats, t: Date.now()});
}, 5000);

send({tag: 'setup_done'});
