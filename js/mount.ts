import { Character } from './character';
import { currentLang, Lang } from './lang';
import { showContextMenu } from './menu';
import { CharacterModel, Manifest, ManifestModel } from './types';

const STORAGE_HIDDEN = 'arkpets.hidden';
const STORAGE_MODEL = 'arkpets.model';

const CANVAS_ID = 'arkpets-pet';
const SMALL_SCREEN = '(max-width: 860px), (pointer: coarse)';
const SMALL_SCREEN_SCALE = 0.8;

const RESTORE_LABEL: { [lang in Lang]: string } = { zh: '显示宠物', en: 'Show pet' };

function readStorage(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch (e) {
        return null;
    }
}

function writeStorage(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch (e) { /* storage may be blocked */ }
}

function displayName(model: ManifestModel, lang: Lang): string {
    const name = model.name[lang];
    return model.skin ? `${name} · ${model.skin[lang]}` : name;
}

// Adds the pet to the page using a manifest. If anything fails, the page is left as it was.
export async function mount(manifestUrl: string): Promise<void> {
    const url = new URL(manifestUrl, document.baseURI);
    const response = await fetch(url.href);
    if (!response.ok) {
        throw new Error(`${url.href}: HTTP ${response.status}`);
    }
    const manifest = await response.json() as Manifest;
    const resourcePath = new URL(manifest.resourcePath, url).href;

    const toCharacterModel = (model: ManifestModel): CharacterModel => ({
        id: model.id,
        name: displayName(model, currentLang()),
        skeleton: model.skeleton,
        atlas: model.atlas,
        texture: model.texture,
        resourcePath,
    });

    const findModel = (id: string | null) => manifest.models.find(m => m.id === id);

    let restoreButton: HTMLButtonElement | null = null;
    let langObserver: MutationObserver | null = null;

    function hideRestoreButton(): void {
        langObserver?.disconnect();
        langObserver = null;
        restoreButton?.remove();
        restoreButton = null;
    }

    function showRestoreButton(): void {
        const button = document.createElement('button');
        button.type = 'button';
        button.id = 'arkpets-restore';
        const updateLabel = () => { button.textContent = RESTORE_LABEL[currentLang()]; };
        updateLabel();
        langObserver = new MutationObserver(updateLabel);
        langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-lang', 'lang'] });
        button.onclick = () => {
            writeStorage(STORAGE_HIDDEN, '0');
            hideRestoreButton();
            showPet();
        };
        document.body.appendChild(button);
        restoreButton = button;
    }

    function showPet(): void {
        const model = findModel(readStorage(STORAGE_MODEL)) ?? findModel(manifest.defaultId) ?? manifest.models[0];
        const displayScale = window.matchMedia(SMALL_SCREEN).matches ? SMALL_SCREEN_SCALE : 1;
        const character: Character = new Character(
            CANVAS_ID,
            (e) => showContextMenu(e, character, {
                getCharacterModels: () => manifest.models.map(toCharacterModel),
                onSelectCharacter: (c, selected) => {
                    writeStorage(STORAGE_MODEL, selected.id);
                    c.loadCharacterModel(selected);
                },
                onHideCharacter: (c) => {
                    writeStorage(STORAGE_HIDDEN, '1');
                    c.fadeOut().then(() => {
                        c.destroy();
                        showRestoreButton();
                    });
                },
                aboutUrl: manifest.about,
            }),
            toCharacterModel(model),
            true,
            displayScale,
        );
    }

    // With prefers-reduced-motion, start hidden and show the button instead
    const hiddenPref = readStorage(STORAGE_HIDDEN);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (hiddenPref === '1' || (hiddenPref === null && reducedMotion)) {
        showRestoreButton();
    } else {
        showPet();
    }
}
