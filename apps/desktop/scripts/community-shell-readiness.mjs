/** Distinguish a mounted application from the nonempty plugin-loading page. */
export function isDesktopUiReady(document) {
  return document?.ready === 'complete' && document.boot === false
    && document.controls > 0 && document.width > 0 && document.height > 0
    && document.text.trim().length > 10
    && !/Loading plugins|Failed to load plugins/u.test(document.text)
}
