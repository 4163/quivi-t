/**
 * proto.js: minimal protobuf wire-format reader.
 *
 * Reads varint, length-delimited, and fixed-width fields from a Uint8Array.
 * No generated code, no runtime dependency.
 */

export class ProtoReader {
  constructor(buf) {
    this._buf = buf;
    this._pos = 0;
  }

  get remaining() {
    return this._buf.length - this._pos;
  }

  readVarint() {
    let value = 0;
    let shift = 0;
    while (this._pos < this._buf.length) {
      const byte = this._buf[this._pos++];
      value |= (byte & 0x7F) << shift;
      if ((byte & 0x80) === 0) return value >>> 0;
      shift += 7;
      if (shift > 35) throw new Error('Varint too long');
    }
    throw new Error('Unexpected end of buffer reading varint');
  }

  readTag() {
    if (this._pos >= this._buf.length) return null;
    const varint = this.readVarint();
    return { field: varint >>> 3, wire: varint & 0x07 };
  }

  readBytes() {
    const len = this.readVarint();
    if (this._pos + len > this._buf.length) {
      throw new Error('Unexpected end of buffer reading bytes');
    }
    const slice = this._buf.slice(this._pos, this._pos + len);
    this._pos += len;
    return slice;
  }

  readString() {
    return new TextDecoder().decode(this.readBytes());
  }

  readSub() {
    return new ProtoReader(this.readBytes());
  }

  skip(wire) {
    switch (wire) {
      case 0: this.readVarint(); break;
      case 1: this._pos += 8; break;
      case 2: this._pos += this.readVarint(); break;
      case 5: this._pos += 4; break;
      default: throw new Error(`Unknown wire type: ${wire}`);
    }
  }
}

export function readFields(reader) {
  const fields = new Map();
  while (reader.remaining > 0) {
    const tag = reader.readTag();
    if (!tag) break;
    const { field, wire } = tag;
    let value;
    if (wire === 0) value = reader.readVarint();
    else if (wire === 2) value = reader.readBytes();
    else { reader.skip(wire); continue; }

    if (!fields.has(field)) fields.set(field, []);
    fields.get(field).push({ wire, value });
  }
  return fields;
}
