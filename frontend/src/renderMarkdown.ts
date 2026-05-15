import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

let purifyHooks = false;
function ensurePurifyHooks() {
  if (purifyHooks) return;
  purifyHooks = true;
  DOMPurify.addHook("uponSanitizeElement", (node, hookEvent, _config) => {
    if (hookEvent.tagName.toLowerCase() !== "a") return;
    if (node instanceof HTMLAnchorElement) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function markdownToSafeHtml(md: string): string {
  ensurePurifyHooks();
  let html: string;
  try {
    const parsed = marked.parse(md, { async: false });
    html = typeof parsed === "string" ? parsed : "";
  } catch {
    html = `<pre class="ai-md-fallback">${escapeHtml(md)}</pre>`;
  }
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
