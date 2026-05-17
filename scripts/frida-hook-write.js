/**
 * Hook write() and recvfrom() / read() in Serato to see TCP socket I/O.
 * Focus on data containing OSC addresses we know about.
 *
 * Usage: frida -p <serato-pid> -l frida-hook-write.js
 */

function hex(buf, len) {
  const out = [];
  const n = Math.min(len, 256);
  for (let i = 0; i < n; i++) {
    out.push(buf.add(i).readU8().toString(16).padStart(2, '0'));
  }
  return out.join(' ');
}
function asciiSafe(buf, len) {
  let s = '';
  const n = Math.min(len, 256);
  for (let i = 0; i < n; i++) {
    const b = buf.add(i).readU8();
    if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
    else s += '.';
  }
  return s;
}
function isInteresting(buf, len) {
  if (len < 4) return false;
  // start with '/' (OSC) or 0x4c 0xaa 0xc2 0xae (sentinel)
  const b0 = buf.readU8();
  const b1 = buf.add(1).readU8();
  const b2 = buf.add(2).readU8();
  const b3 = buf.add(3).readU8();
  if (b0 === 0x2f) return true;
  if (b0 === 0x4c && b1 === 0xaa && b2 === 0xc2 && b3 === 0xae) return true;
  return false;
}

const writePtr = Module.getExportByName(null, 'write');
Interceptor.attach(writePtr, {
  onEnter(args) {
    const fd = args[0].toInt32();
    const buf = args[1];
    const len = args[2].toInt32();
    if (!isInteresting(buf, len)) return;
    send({
      type: 'WRITE',
      fd, len,
      hex: hex(buf, len),
      ascii: asciiSafe(buf, len),
    });
  },
});

// Also hook recvfrom/recv for incoming data
const recvfrom = Module.getExportByName(null, 'recvfrom');
Interceptor.attach(recvfrom, {
  onEnter(args) {
    this.fd = args[0].toInt32();
    this.buf = args[1];
    this.maxlen = args[2].toInt32();
  },
  onLeave(retval) {
    const n = retval.toInt32();
    if (n <= 0) return;
    if (!isInteresting(this.buf, n)) return;
    send({
      type: 'RECV',
      fd: this.fd,
      len: n,
      hex: hex(this.buf, n),
      ascii: asciiSafe(this.buf, n),
    });
  },
});

const readPtr = Module.getExportByName(null, 'read');
Interceptor.attach(readPtr, {
  onEnter(args) {
    this.fd = args[0].toInt32();
    this.buf = args[1];
  },
  onLeave(retval) {
    const n = retval.toInt32();
    if (n <= 0 || n > 4096) return;
    if (!isInteresting(this.buf, n)) return;
    send({
      type: 'READ',
      fd: this.fd,
      len: n,
      hex: hex(this.buf, n),
      ascii: asciiSafe(this.buf, n),
    });
  },
});

console.log('hooks installed');
