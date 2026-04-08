/* ================================================================
 * pdf.js — PDF.js 适配器（Vite 兼容版）
 *
 * 将 PDF.js 渲染结果适配为 foliate-js 的 book 接口,
 * 使用固定布局渲染器（fixed-layout.js）逐页展示 PDF。
 *
 * 直接导入 pdfjs-dist npm 包，无需 vendor 拷贝。
 * ================================================================ */

import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import pdfViewerCSS from "pdfjs-dist/web/pdf_viewer.css?raw";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

/* ----------------------------------------------------------------
 * render — 将单页 PDF 渲染到 iframe 文档中
 * ---------------------------------------------------------------- */
const render = async (page, doc, zoom) => {
  const scale = zoom * devicePixelRatio;
  doc.documentElement.style.transform = `scale(${1 / devicePixelRatio})`;
  doc.documentElement.style.transformOrigin = "top left";
  doc.documentElement.style.setProperty("--scale-factor", scale);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.height = viewport.height;
  canvas.width = viewport.width;
  const canvasContext = canvas.getContext("2d");
  await page.render({ canvasContext, viewport }).promise;
  doc.querySelector("#canvas").replaceChildren(doc.adoptNode(canvas));

  // 文本层
  const container = doc.querySelector(".textLayer");
  const textLayer = new pdfjsLib.TextLayer({
    textContentSource: await page.streamTextContent(),
    container,
    viewport,
  });
  await textLayer.render();

  // 隐藏 PDF.js 在 document 上创建的离屏 canvas
  for (const c of document.querySelectorAll(".hiddenCanvasElement"))
    Object.assign(c.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
      display: "none",
    });

  // 修复文本选择
  const endOfContent = document.createElement("div");
  endOfContent.className = "endOfContent";
  container.append(endOfContent);
  container.onpointerdown = () => container.classList.add("selecting");
  container.onpointerup = () => container.classList.remove("selecting");

  // 注释层
  const div = doc.querySelector(".annotationLayer");
  const linkService = {
    goToDestination: () => {},
    getDestinationHash: (dest) => JSON.stringify(dest),
    addLinkAttributes: (link, url) => (link.href = url),
  };
  await new pdfjsLib.AnnotationLayer({ page, viewport, div, linkService }).render({
    annotations: await page.getAnnotations(),
  });
};

/* ----------------------------------------------------------------
 * renderPage — 生成单页的 blob URL 或封面图片
 * ---------------------------------------------------------------- */
const renderPage = async (page, getImageBlob) => {
  const viewport = page.getViewport({ scale: 1 });

  if (getImageBlob) {
    const canvas = document.createElement("canvas");
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    const canvasContext = canvas.getContext("2d");
    await page.render({ canvasContext, viewport }).promise;
    return new Promise((resolve) => canvas.toBlob(resolve));
  }

  const src = URL.createObjectURL(
    new Blob(
      [
        `<!DOCTYPE html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=${viewport.width}, height=${viewport.height}">
<style>
html, body { margin: 0; padding: 0; }
:root {
  --user-unit: 1;
  --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
  --scale-round-x: 1px;
  --scale-round-y: 1px;
}
${pdfViewerCSS}
</style>
<div id="canvas"></div>
<div class="textLayer"></div>
<div class="annotationLayer"></div>`,
      ],
      { type: "text/html" },
    ),
  );

  const onZoom = ({ doc, scale }) => render(page, doc, scale);
  return { src, onZoom };
};

/* ----------------------------------------------------------------
 * TOC 转换
 * ---------------------------------------------------------------- */
const makeTOCItem = (item) => ({
  label: item.title,
  href: JSON.stringify(item.dest),
  subitems: item.items.length ? item.items.map(makeTOCItem) : null,
});

/* ----------------------------------------------------------------
 * makePDF — 主入口，返回 book 对象
 * ---------------------------------------------------------------- */
export const makePDF = async (file) => {
  const transport = new pdfjsLib.PDFDataRangeTransport(file.size, []);
  transport.requestDataRange = (begin, end) => {
    file
      .slice(begin, end)
      .arrayBuffer()
      .then((chunk) => transport.onDataRange(begin, chunk));
  };

  const pdf = await pdfjsLib.getDocument({
    range: transport,
    isEvalSupported: false,
  }).promise;

  const book = { rendition: { layout: "pre-paginated" } };

  // 元数据
  const { metadata, info } = (await pdf.getMetadata()) ?? {};
  book.metadata = {
    title: metadata?.get("dc:title") ?? info?.Title,
    author: metadata?.get("dc:creator") ?? info?.Author,
    contributor: metadata?.get("dc:contributor"),
    description: metadata?.get("dc:description") ?? info?.Subject,
    language: metadata?.get("dc:language"),
    publisher: metadata?.get("dc:publisher"),
    subject: metadata?.get("dc:subject"),
    identifier: metadata?.get("dc:identifier"),
    source: metadata?.get("dc:source"),
    rights: metadata?.get("dc:rights"),
  };

  // 目录
  const outline = await pdf.getOutline();
  book.toc = outline?.map(makeTOCItem);

  // sections
  const cache = new Map();
  book.sections = Array.from({ length: pdf.numPages }).map((_, i) => ({
    id: i,
    load: async () => {
      const cached = cache.get(i);
      if (cached) return cached;
      const url = await renderPage(await pdf.getPage(i + 1));
      cache.set(i, url);
      return url;
    },
    size: 1000,
  }));

  book.isExternal = (uri) => /^\w+:/i.test(uri);

  book.resolveHref = async (href) => {
    const parsed = JSON.parse(href);
    const dest = typeof parsed === "string" ? await pdf.getDestination(parsed) : parsed;
    const index = await pdf.getPageIndex(dest[0]);
    return { index };
  };

  book.splitTOCHref = async (href) => {
    const parsed = JSON.parse(href);
    const dest = typeof parsed === "string" ? await pdf.getDestination(parsed) : parsed;
    const index = await pdf.getPageIndex(dest[0]);
    return [index, null];
  };

  book.getTOCFragment = (doc) => doc.documentElement;
  book.getCover = async () => renderPage(await pdf.getPage(1), true);
  book.destroy = () => pdf.destroy();

  return book;
};
