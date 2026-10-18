// Small DOM builder. Text is always set with textContent (no HTML injection) and CSS custom
// properties via CSSOM, so pages work under a strict Content-Security-Policy.

type Child = Node | string | null | undefined | false;
type AttrValue = string | number | boolean | null | undefined;
interface Attrs {
  /** CSS custom properties, e.g. { '--c': '#ff0000' }. */
  vars?: Record<string, string>;
  /** Event listeners, e.g. { click: () => ... }. */
  on?: Record<string, (e: Event) => void>;
  [attribute: string]: AttrValue | Record<string, string> | Record<string, (e: Event) => void>;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, raw] of Object.entries(attrs)) {
    if (k === 'vars' || k === 'on') continue;
    const v = raw as AttrValue;
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const [name, value] of Object.entries(attrs.vars ?? {})) el.style.setProperty(name, value);
  for (const [event, fn] of Object.entries(attrs.on ?? {})) el.addEventListener(event, fn);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Replace all children of `el`. */
export function replaceChildren(el: Element, ...children: Child[]): void {
  el.replaceChildren(...(children.filter((c) => c !== null && c !== undefined && c !== false) as Array<Node | string>));
}

export function setAccentColor(color: string): void {
  if (/^#[0-9a-fA-F]{6}$/.test(color)) document.documentElement.style.setProperty('--accent', color);
}
