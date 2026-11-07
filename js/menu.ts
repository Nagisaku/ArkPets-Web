import { Character } from './character';
import { currentLang, Lang } from './lang';
import { CharacterModel } from './types';

import '../styles.css';

interface MenuCallbacks {
    getCharacterModels?: () => CharacterModel[];
    onSelectCharacter?: (c: Character, model: CharacterModel) => void;
    onHideCharacter?: (c: Character) => void;
    aboutUrl?: string;
}

const LABELS: { [lang in Lang]: { [key: string]: string } } = {
    zh: {
        characters: '角色', actions: '动作', hide: '隐藏', about: '关于',
        Relax: '待机', Move: '走动', Sit: '坐下', Sleep: '睡觉', Interact: '互动', Special: '特殊',
    },
    en: {
        characters: 'Characters', actions: 'Actions', hide: 'Hide', about: 'About',
        Relax: 'Idle', Move: 'Walk', Sit: 'Sit', Sleep: 'Sleep', Interact: 'Interact', Special: 'Special',
    },
};

const SCREEN_MARGIN = 4;

function positionElement(element: HTMLElement, x: number, y: number, parentRect?: DOMRect): void {
    const { innerWidth, innerHeight } = window;
    const { offsetWidth, offsetHeight } = element;

    let left = x;
    // A submenu that doesn't fit on the right opens on the left of its parent
    if (parentRect && x + offsetWidth > innerWidth - SCREEN_MARGIN) {
        left = parentRect.left - offsetWidth;
    }
    left = Math.max(SCREEN_MARGIN, Math.min(left, innerWidth - offsetWidth - SCREEN_MARGIN));
    const top = Math.max(SCREEN_MARGIN, Math.min(y, innerHeight - offsetHeight - SCREEN_MARGIN));

    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
}

function createMenuItem(label: string, onClick?: () => void): HTMLElement {
    const item = document.createElement('div');
    item.className = 'arkpets-menu-item';
    item.textContent = label;
    if (onClick) {
        item.onclick = (e) => {
            e.stopPropagation();
            removeMenu();
            onClick();
        };
    }
    return item;
}

function addSubmenu(menu: HTMLElement, label: string, items: HTMLElement[]): void {
    const parent = createMenuItem(`${label} ▶`);
    const submenu = document.createElement('div');
    submenu.className = 'arkpets-submenu';
    items.forEach(item => submenu.appendChild(item));
    submenu.style.display = 'none';
    parent.appendChild(submenu);

    const open = () => {
        menu.querySelectorAll<HTMLElement>('.arkpets-submenu').forEach(s => s.style.display = 'none');
        submenu.style.display = 'block';
        const rect = parent.getBoundingClientRect();
        positionElement(submenu, rect.right, rect.top, rect);
    };
    // Hover for mice, click for touch. Touch also fires an emulated mouseover first,
    // so click must only ever open, not toggle.
    parent.onmouseover = open;
    parent.onclick = open;
    parent.onmouseout = (e) => {
        if (!parent.contains(e.relatedTarget as Node | null)) {
            submenu.style.display = 'none';
        }
    };

    menu.appendChild(parent);
}

export function showContextMenu(e: MouseEvent | TouchEvent, c: Character, callbacks: MenuCallbacks): void {
    e.preventDefault();
    removeMenu();

    const labels = LABELS[currentLang()];
    const menu = document.createElement('div');
    menu.id = 'arkpets-menu';

    // Add Characters submenu if there are characters
    const models = callbacks.getCharacterModels?.();
    if (models && models.length > 0) {
        addSubmenu(menu, labels.characters, models.map(model => {
            const item = createMenuItem(model.name, () => {
                const select = callbacks.onSelectCharacter ?? (() => c.loadCharacterModel(model));
                select(c, model);
            });
            item.classList.toggle('arkpets-menu-current', model.id === c.getModel().id);
            return item;
        }));
    }

    addSubmenu(menu, labels.actions, c.getAnimationNames().map(animation =>
        createMenuItem(labels[animation] ?? animation, () => c.playAnimation(animation))
    ));

    menu.appendChild(createMenuItem(labels.hide, () => {
        const hide = callbacks.onHideCharacter ?? (() => {
            c.fadeOut().then(() => c.destroy());
        });
        hide(c);
    }));

    menu.appendChild(createMenuItem(labels.about, () => {
        window.open(callbacks.aboutUrl ?? 'https://github.com/fuyufjh/ArkPets-Web/', '_blank', 'noopener');
    }));

    // The menu is position: fixed, so use client coordinates
    const point = 'touches' in e ? e.touches[0] : e;
    document.body.appendChild(menu);
    positionElement(menu, point.clientX, point.clientY);

    // Remove menu when clicking outside
    const handleClickOutside = (event: MouseEvent) => {
        if (!menu.contains(event.target as Node)) {
            removeMenu();
        }
    };
    menuCleanup = () => document.removeEventListener('click', handleClickOutside);

    // Delay adding the click listener to prevent immediate removal
    setTimeout(() => {
        if (menu.isConnected) {
            document.addEventListener('click', handleClickOutside);
        }
    }, 0);
}

let menuCleanup: (() => void) | null = null;

function removeMenu(): void {
    document.getElementById('arkpets-menu')?.remove();
    menuCleanup?.();
    menuCleanup = null;
}
