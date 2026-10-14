import sharp from 'sharp'
const [a, b, out] = process.argv.slice(2)
const ia = await sharp(a).resize({ height: 1400 }).toBuffer(); const ib = await sharp(b).resize({ height: 1400 }).toBuffer()
const ma = await sharp(ia).metadata(); const mb = await sharp(ib).metadata()
await sharp({ create: { width: ma.width! + mb.width! + 20, height: 1400, channels: 3, background: '#444' } }).composite([{ input: ia, left: 0, top: 0 }, { input: ib, left: ma.width! + 20, top: 0 }]).jpeg({ quality: 70 }).toFile(out!)
