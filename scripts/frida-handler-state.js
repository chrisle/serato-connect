/**
 * Single hook at handler entry. Read the list bounds and dump every entry,
 * plus our incoming blob. Compare programmatically.
 */

const mod = Process.enumerateModules()[0];
send({tag: 'main', base: mod.base.toString()});

function readBytes(p, n) {
  try { return Array.from(new Uint8Array(p.readByteArray(n))).map(b => b.toString(16).padStart(2, '0')).join(' '); }
  catch (e) { return null; }
}

const HANDLER = mod.base.add(0xb78cfc);
let n = 0;
Interceptor.attach(HANDLER, {
  onEnter(args) {
    n++;
    const x19 = this.context.x1;          // first arg ptr (this->something)
    const x2  = this.context.x2;          // OSC args struct ptr

    const out = {tag: 'STATE', n, t: Date.now()};

    try {
      // List range: [x19+0x128, x19+0x130)
      const listStart = x19.add(0x128).readPointer();
      const listEnd   = x19.add(0x130).readPointer();
      const stride = 0x20;
      const listBytes = listEnd.sub(listStart).toUInt32();
      out.list_start = listStart.toString();
      out.list_end = listEnd.toString();
      out.list_count = Math.floor(listBytes / stride);
      out.entries = [];
      for (let i = 0; i < Math.min(out.list_count, 4); i++) {
        const e = listStart.add(i * stride);
        out.entries.push({i, off: i*stride, bytes: readBytes(e, stride)});
      }
    } catch(e) { out.list_err = e.message; }

    try {
      // x2 is OSC args. Looking at disasm: ldr x8, [x2,#8]; ldr x9, [x2,#0x18]
      out.x2_at_8 = x2.add(8).readPointer().toString();
      out.x2_at_18 = x2.add(0x18).readPointer().toString();
      out.x2_dump = readBytes(x2, 64);
    } catch(e) { out.x2_err = e.message; }

    // Read more around x19 — the object state
    try {
      out.x19 = x19.toString();
      out.x19_0xb8 = x19.add(0xb8).readPointer().toString();  // the "obj" used in blr call
      out.x19_0xe8 = x19.add(0xe8).readPointer().toString();  // fn ptr
      out.x19_0xf0 = x19.add(0xf0).readPointer().toString();
      out.x19_0x108_dump = readBytes(x19.add(0x108), 32);     // ctx for comparator
    } catch(e) { out.x19_err = e.message; }

    send(out);
  },
  onLeave(rv) { send({tag: 'STATE_leave', n, retval: rv.toString(), t: Date.now()}); }
});
send({tag: 'hooked'});

let beats = 0;
setInterval(() => { beats++; send({tag: 'beat', n: beats}); }, 5000);
send({tag: 'setup_done'});
