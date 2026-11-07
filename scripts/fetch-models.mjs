// Downloads the models listed in models.config.json and writes a manifest next to them.
// Usage: node scripts/fetch-models.mjs <output directory>
//
// The model files are copyrighted by Hypergryph, so they are not stored in this repository.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const outDir = process.argv[2];
if (!outDir) {
    console.error('Usage: node scripts/fetch-models.mjs <output directory>');
    process.exit(1);
}

const configUrl = new URL('../models.config.json', import.meta.url);
const config = JSON.parse(await readFile(configUrl, 'utf8'));
const { repository, commit, directory } = config.source;

if (!config.models.some(model => model.id === config.defaultId)) {
    throw new Error(`defaultId ${config.defaultId} is not in the models list`);
}

async function download(id, file) {
    const url = `https://raw.githubusercontent.com/${repository}/${commit}/${directory}/${encodeURIComponent(id)}/${encodeURIComponent(file)}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`${url}: HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

const models = [];
for (const model of config.models) {
    const base = `build_char_${model.id}`;
    const files = { skeleton: `${base}.skel`, atlas: `${base}.atlas`, texture: `${base}.png` };
    const dir = path.join(outDir, 'models', model.id);
    await mkdir(dir, { recursive: true });

    let bytes = 0;
    for (const file of Object.values(files)) {
        const data = await download(model.id, file);
        await writeFile(path.join(dir, file), data);
        bytes += data.length;

        // The loader assumes one texture named after the model, so catch anything else here
        if (file === files.atlas && !data.toString('utf8').includes(files.texture)) {
            throw new Error(`${file} does not reference ${files.texture}`);
        }
    }
    console.log(`${model.id}: ${(bytes / 1024).toFixed(0)} KB`);

    models.push({
        ...model,
        skeleton: `${model.id}/${files.skeleton}`,
        atlas: `${model.id}/${files.atlas}`,
        texture: `${model.id}/${files.texture}`,
    });
}

const manifest = { defaultId: config.defaultId, resourcePath: 'models/', about: config.about, models };
await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote ${models.length} models to ${outDir}`);
