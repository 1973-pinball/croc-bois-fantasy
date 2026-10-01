import { createRequire } from "node:module";
import fs from "node:fs/promises";
const require=createRequire(import.meta.url);
const sharp=require(require.resolve("sharp",{paths:[require.resolve("next")]}));
const source="public/images/croc-bois-mascot.png";

async function render(size, padding, background={r:0,g:0,b:0,alpha:0}) {
  const mascot=await sharp(source).resize(size-padding*2,size-padding*2,{fit:"inside",withoutEnlargement:true}).png().toBuffer();
  return sharp({create:{width:size,height:size,channels:4,background}}).composite([{input:mascot,gravity:"centre"}]).png().toBuffer();
}

for (const size of [192,512]) await fs.writeFile(`public/icon-${size}.png`,await render(size,Math.round(size*.045)));
await fs.writeFile("src/app/icon.png",await render(96,4));
await fs.writeFile("src/app/apple-icon.png",await render(180,8));
// Keep the entire mascot inside the central maskable safe circle.
await fs.writeFile("public/icon-maskable-512.png",await render(512,114,{r:244,g:242,b:233,alpha:1}));

// Modern ICO files can contain lossless PNG images, preserving the mascot's alpha.
const faviconSizes=[16,32,48];
const images=await Promise.all(faviconSizes.map(size=>render(size,size===16?1:2)));
const directory=Buffer.alloc(6+images.length*16);
directory.writeUInt16LE(1,2);directory.writeUInt16LE(images.length,4);
let offset=directory.length;
for(let index=0;index<images.length;index++){
  const entry=6+index*16;
  directory[entry]=faviconSizes[index];directory[entry+1]=faviconSizes[index];
  directory.writeUInt16LE(1,entry+4);directory.writeUInt16LE(32,entry+6);
  directory.writeUInt32LE(images[index].length,entry+8);directory.writeUInt32LE(offset,entry+12);
  offset+=images[index].length;
}
await fs.writeFile("src/app/favicon.ico",Buffer.concat([directory,...images]));
console.log("Rendered transparent mascot favicon, browser, Apple and PWA icons, plus a cream maskable icon.");
