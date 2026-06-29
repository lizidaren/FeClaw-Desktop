// =========================================================
// FeClaw Desktop — Markdown rendering (Phase 2 / 2.2 B)
// =========================================================
//
// Pipeline: marked.parse → DOMPurify.sanitize → DOM mutations for
// image src + link safety. Highlight.js is wired in by marked as a
// custom renderer, so fenced code blocks get syntax classes.
//
// The three libraries are loaded as plain <script> tags in
// chat/index.html (vendor/marked.min.js etc.) and exposed as globals
// on `window`. We re-export them as typed handles below so the rest
// of the chat code can use them through `import { ... } from "./markdown"`.

export interface MarkedToken {
  type: string;
  raw?: string;
  text?: string;
  href?: string;
  src?: string;
  lang?: string;
  tokens?: MarkedToken[];
  items?: MarkedToken[];
}

export interface MarkedApi {
  parse(src: string, opts?: Record<string, unknown>): string;
  setOptions(opts: Record<string, unknown>): void;
}

export interface DomPurifyApi {
  sanitize(
    dirty: string,
    cfg?: Record<string, unknown>,
  ): string;
}

export interface HljsApi {
  highlight(code: string, opts: { language: string }): { value: string };
  highlightAuto(code: string): { value: string };
  highlightElement(el: Element): void;
  registerLanguage(name: string, def: unknown): void;
}

declare global {
  interface Window {
    marked?: MarkedApi;
    DOMPurify?: DomPurifyApi;
    hljs?: HljsApi;
  }
}

function requireMarked(): MarkedApi {
  const m = window.marked;
  if (!m) {
    throw new Error(
      "marked is not loaded — check that vendor/marked.min.js is included in chat/index.html",
    );
  }
  return m;
}

function requireDomPurify(): DomPurifyApi {
  const d = window.DOMPurify;
  if (!d) {
    throw new Error(
      "DOMPurify is not loaded — check that vendor/purify.min.js is included in chat/index.html",
    );
  }
  return d;
}

function requireHljs(): HljsApi | null {
  return window.hljs ?? null;
}

// ---- Configuration -------------------------------------------

let configured = false;

/**
 * Set up the marked → DOMPurify pipeline. Idempotent — safe to call
 * from multiple places (re-renders, hot-reloads).
 */
export function configureMarkdown(): void {
  if (configured) return;
  const marked = requireMarked();
  const hljs = requireHljs();

  // Code blocks: if highlight.js is present, give marked a renderer that
  // produces `<pre><code class="hljs language-X">` so hljs.highlightElement
  // can pick it up after insertion.
  marked.setOptions({
    gfm: true,
    breaks: true,
    // Don't run highlight here — we'll call hljs.highlightElement after
    // DOM insertion so the colour scheme picks up the current theme.
  });

  configured = true;
  // Touch hljs so bundlers / lint tools know it's intentionally referenced.
  void hljs;
}

// ---- Public API ----------------------------------------------

/**
 * Render a markdown string to a sanitised HTML string.
 *
 * Image `src` attributes are NOT filtered here — the caller must run
 * them through `pickSafeImageSrc` (or the equivalent) when inserting
 * into the DOM, because DOMPurify's default allow-list already strips
 * SVG data URIs. The link rewrites are applied here so any `<a>` in
 * the output is `target=_blank rel="noopener noreferrer"` (the
 * Tauri-side `on_new_window_request` handler opens them as new
 * windows).
 */
export function renderMarkdown(src: string): string {
  configureMarkdown();
  const marked = requireMarked();
  const DOMPurify = requireDomPurify();

  const html = marked.parse(src);

  // DOMPurify config:
  //   - allow the tags marked produces
  //   - allow `target`, `rel`, and `class` on links (so hljs classes
  //     on code blocks survive sanitisation)
  const clean = DOMPurify.sanitize(html, {
    ADD_ATTR: ["target", "rel"],
    ADD_TAGS: [],
    FORBID_TAGS: ["style", "script", "iframe", "form"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "style"],
  });
  return clean;
}

/**
 * Post-process a freshly-rendered DOM subtree (e.g. one produced by
 * setting `innerHTML` to the result of renderMarkdown) to:
 *   1. Strip unsafe image `src` values (SVG data URIs, javascript:).
 *   2. Add `target="_blank"` and safe `rel` to outbound links.
 *   3. Apply syntax highlighting to `<pre><code>` blocks if hljs is
 *      available.
 */
export function decorateMarkdownRoot(root: HTMLElement): void {
  // 1. Image sanitisation — drop the element if the src isn't allowed.
  root.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    if (!isSafeImageUrl(src)) {
      // Replace with a placeholder so the layout doesn't shift.
      img.replaceWith(
        Object.assign(document.createElement("span"), {
          className: "image-blocked",
          textContent: "[图片类型不支持预览]",
        }),
      );
    } else {
      // Force lazy loading and stable referrer to avoid leaking.
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
    }
  });

  // 2. Link hardening — only touch http(s); ignore in-page anchors.
  root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("http://") || href.startsWith("https://")) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    }
  });

  // 3. Syntax highlighting (best-effort — silently no-op if hljs
  //    isn't loaded or fails).
  const hljs = requireHljs();
  if (hljs) {
    root.querySelectorAll<HTMLElement>("pre code").forEach((el) => {
      try {
        hljs.highlightElement(el);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("hljs.highlightElement failed:", e);
      }
    });
  }
}

// ---- URL safety helpers --------------------------------------

/**
 * Mirror of chat.ts's `pickSafeImageSrc` semantics, but operating on
 * raw URL strings (no Image element involved). Kept in sync with
 * SAFE_IMAGE_MIMES in chat.ts — when that whitelist changes, update
 * here too.
 */
const SAFE_DATA_IMAGE_PREFIX_RE =
  /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

function isSafeImageUrl(src: string): boolean {
  if (!src) return false;
  if (src.startsWith("https://") || src.startsWith("http://")) return true;
  return SAFE_DATA_IMAGE_PREFIX_RE.test(src);
}