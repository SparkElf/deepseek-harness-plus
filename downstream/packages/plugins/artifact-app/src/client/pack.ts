/**
 * 模板目录 → zip（store 模式）。
 *
 * 与后端 `zip-store` 保持同一算法：素材多为已压缩格式，deflate 收益接近 0，
 * 用 store 可以零依赖且实现简单。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

const crc32 = (buffer: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

interface Entry { name: string; data: Buffer }

/** zip 打包（仅 store）。 */
const zipStore = (entries: Entry[]): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const size = entry.data.byteLength;
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(local, entry.data);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);
    offset += local.length + size;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
};

/**
 * 递归读取目录并打包。
 *
 * @param dir - 模板目录（含 template.json / template.html / assets/）。
 * @returns zip 字节。
 */
export const packTemplateDir = async (dir: string): Promise<Buffer> => {
  const entries: Entry[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const name of await readdir(current)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const full = join(current, name);
      const info = await stat(full);
      if (info.isDirectory()) { await walk(full); continue; }
      entries.push({ name: relative(dir, full).split(sep).join('/'), data: await readFile(full) });
    }
  };
  await walk(dir);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return zipStore(entries);
};
