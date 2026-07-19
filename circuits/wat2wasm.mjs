import { readFileSync, writeFileSync } from 'fs';
import wabtInit from 'wabt';

const wabt = await wabtInit();
const path = process.argv[2];
const outPath = process.argv[3];
const watContent = readFileSync(path, 'utf8');
const module = wabt.parseWat(path, watContent);
const { buffer } = module.toBinary({});
writeFileSync(outPath, Buffer.from(buffer));
console.log('wrote', outPath, buffer.length, 'bytes');
