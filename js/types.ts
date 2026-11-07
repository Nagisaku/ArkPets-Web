export interface CharacterModel {
    id: string;
    name: string;
    skeleton: string;
    atlas: string;
    texture: string;
    resourcePath?: string;
}

export interface LocalizedName {
    zh: string;
    en: string;
}

export interface ManifestModel {
    id: string;
    name: LocalizedName;
    skin?: LocalizedName;
    skeleton: string;
    atlas: string;
    texture: string;
}

// Written by scripts/fetch-models.mjs
export interface Manifest {
    defaultId: string;
    // Relative to the manifest's own URL
    resourcePath: string;
    about?: string;
    models: ManifestModel[];
}
