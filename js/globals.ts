import { Character } from './character';
import { showContextMenu } from './menu';
import { mount } from './mount';
import type { CharacterModel } from './types';

// Export everything from a single entry point
export {
    Character,
    showContextMenu,
    mount,
    CharacterModel,
};

// For UMD bundle
const arkpets = {
    Character,
    showContextMenu,
    mount,
};

export default arkpets;

// <script src="arkpets.js" data-arkpets-manifest="manifest.json" defer></script>
// mounts the pet by itself. currentScript is only readable while this file first runs.
const manifestUrl = (document.currentScript as HTMLScriptElement | null)?.dataset.arkpetsManifest;
if (manifestUrl) {
    const start = () => mount(manifestUrl).catch(error => console.error('ArkPets did not start:', error));
    if (document.readyState === 'complete') {
        start();
    } else {
        window.addEventListener('load', start, { once: true });
    }
}
