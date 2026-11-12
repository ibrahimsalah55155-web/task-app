/** Tiny DOM helpers. No innerHTML: all text goes through textContent. */

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === "class") {
        el.className = String(v);
      } else if (k === "value" && "value" in el) {
        (el as HTMLInputElement).value = String(v);
      } else {
        el.setAttribute(k, v === true ? "" : String(v));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

export function replace(el: Element, ...children: Child[]): void {
  while (el.firstChild) el.removeChild(el.firstChild);
  append(el, children);
}

/** Clickable element styled as a button. Disabled buttons ignore clicks. */
export function button(
  label: string,
  onClick: () => void,
  opts: { kind?: "primary" | "secondary" | "danger" | "ghost"; disabled?: boolean; title?: string } = {},
): HTMLDivElement {
  const el = h("div", {
    class: `btn btn-${opts.kind ?? "secondary"}${opts.disabled ? " is-disabled" : ""}`,
    role: "button",
    tabindex: opts.disabled ? -1 : 0,
    title: opts.title,
  }, label);
  if (!opts.disabled) {
    el.addEventListener("click", onClick);
    el.addEventListener("keydown", (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === "Enter" || k === " ") onClick();
    });
  }
  return el;
}

export type Tone = "ok" | "warn" | "bad" | "muted" | "info";

export function pill(text: string, tone: Tone): HTMLSpanElement {
  return h("span", { class: `pill pill-${tone}` }, text);
}

export function row(label: string, value: Child, tone?: Tone): HTMLDivElement {
  return h("div", { class: "kv" },
    h("span", { class: "kv-k" }, label),
    h("span", { class: `kv-v${tone ? ` tone-${tone}` : ""}` }, value));
}

export function card(title: string, right: Child, ...body: Child[]): HTMLDivElement {
  return h("div", { class: "card" },
    h("div", { class: "card-head" }, h("span", { class: "card-title" }, title), h("div", { class: "card-right" }, right)),
    h("div", { class: "card-body" }, ...body));
}

export function progress(fraction: number, label?: string): HTMLDivElement {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return h("div", { class: "progress" },
    h("div", { class: "progress-track" }, h("div", { class: "progress-bar", style: `width: ${pct}%` })),
    h("span", { class: "progress-label" }, label ? `${label} · ${pct}%` : `${pct}%`));
}
