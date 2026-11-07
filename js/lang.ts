export type Lang = 'zh' | 'en';

// Follows the host page's <html data-lang>, falling back to its lang attribute and the browser.
export function currentLang(): Lang {
    const root = document.documentElement;
    const lang = root.getAttribute('data-lang') || root.lang || navigator.language || '';
    return /^zh/i.test(lang) ? 'zh' : 'en';
}
