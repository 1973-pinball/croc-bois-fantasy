import { createRequire } from "node:module";
import fs from "node:fs/promises";
const require=createRequire(import.meta.url);
const sharp=require(require.resolve("sharp",{paths:[require.resolve("next")]}));
await fs.mkdir("public",{recursive:true});
for (const size of [192,512]) await sharp("src/app/icon.svg").resize(size,size).png().toFile(`public/icon-${size}.png`);
console.log("Rendered 192px and 512px PWA icons.");
