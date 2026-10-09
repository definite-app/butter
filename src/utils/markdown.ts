import { marked } from "marked";
import DOMPurify from "dompurify";
import { convertFileSrc } from "@tauri-apps/api/core";
import { inferImageMimeType } from "./clipboard";

marked.setOptions({
  gfm: true,
  breaks: true,
});

const LOCAL_FILE_PREFIXES = [
  "/Applications/",
  "/Library/",
  "/System/",
  "/Users/",
  "/Volumes/",
  "/opt/",
  "/private/",
  "/tmp/",
  "/var/",
];

function safeDecodeUri(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function localPathFromImageSrc(src: string): string | null {
  if (src.startsWith("file://")) {
    try {
      const url = new URL(src);
      return inferImageMimeType(url.pathname) ? safeDecodeUri(url.pathname) : null;
    } catch {
      return null;
    }
  }

  const decoded = safeDecodeUri(src);
  if (!inferImageMimeType(decoded)) return null;
  if (LOCAL_FILE_PREFIXES.some((prefix) => decoded.startsWith(prefix))) {
    return decoded;
  }
  return null;
}

function rewriteLocalImageSources(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const image of Array.from(template.content.querySelectorAll("img"))) {
    const src = image.getAttribute("src");
    if (!src) continue;
    const localPath = localPathFromImageSrc(src);
    if (!localPath) continue;
    image.setAttribute("data-butter-local-image-path", localPath);
    image.setAttribute("src", convertFileSrc(localPath));
    image.setAttribute("loading", "lazy");
  }
  return template.innerHTML;
}

export function renderMarkdownToSafeHtml(source: string): string {
  const raw = marked.parse(source, { async: false }) as string;
  const sanitized = DOMPurify.sanitize(raw, {
    ADD_ATTR: ["target", "data-butter-local-image-path", "loading"],
  });
  return rewriteLocalImageSources(sanitized);
}
