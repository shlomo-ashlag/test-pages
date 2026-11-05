// shared helper for test pages
// - every element with data-expect-type gets its first link checked with a HEAD request,
//   the result goes to its [data-check] element
// - [data-browser-notice="Firefox"] is shown when the page is open in another browser
(() => {
  "use strict";

  const mediaType = value => (value ?? "").split(";")[0].trim().toLowerCase();
  const normalize = value => (value ?? "").trim().toLowerCase().replace(/\s*([;=])\s*/g, "$1");

  function describe(type, disposition) {
    const typeText = type || "no Content-Type";
    const dispositionText = disposition ? `Content-Disposition: ${disposition}` : "no Content-Disposition";
    return `${typeText}, ${dispositionText}`;
  }

  function show(output, state, text) {
    output.className = `check is-${state}`;
    output.textContent = text;
  }

  async function checkCase(item) {
    const link = item.querySelector("a[href]");
    const output = item.querySelector("[data-check]");
    if (!link || !output) {
      return;
    }
    const expectedType = item.dataset.expectType ?? "";
    const expectedDisposition = item.dataset.expectDisposition ?? "";

    let response;
    try {
      response = await fetch(link.href, { method: "HEAD", cache: "no-store" });
    } catch (error) {
      show(output, "bad", `Could not reach the server (${error.message}). Open this page from the site, not as a local file.`);
      return;
    }
    if (response.redirected) {
      show(output, "bad", `The link redirects to ${response.url}, the case needs the link URL itself.`);
      return;
    }
    if (!response.ok) {
      show(output, "bad", `The server answers ${response.status} for this link.`);
      return;
    }

    const type = mediaType(response.headers.get("content-type"));
    const disposition = (response.headers.get("content-disposition") ?? "").trim();
    if (type === expectedType && normalize(disposition) === normalize(expectedDisposition)) {
      show(output, "ok", `Server OK: ${describe(type, disposition)}.`);
      return;
    }
    show(
      output,
      "bad",
      `Server sends ${describe(type, disposition)}, the case needs ${describe(expectedType, expectedDisposition)}. The site is not set up for this case, see the README.`,
    );
  }

  for (const notice of document.querySelectorAll("[data-browser-notice]")) {
    notice.hidden = navigator.userAgent.includes(`${notice.dataset.browserNotice}/`);
  }
  for (const item of document.querySelectorAll("[data-expect-type]")) {
    void checkCase(item);
  }
})();
