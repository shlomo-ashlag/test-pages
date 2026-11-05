// local server for the test pages
// it reads .do/app.yaml for the site folder, the error page and the rewrite rules,
// so every test answers here the same way as on DigitalOcean
// run: node serve.js   then open http://localhost:8080
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || "127.0.0.1";

// the types app platform sends for these extensions
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/vnd.microsoft.icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".bin": "application/octet-stream",
};

// reads the yaml subset the app spec uses: nested maps, lists, plain scalars and # comments
function parseYaml(text) {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.replace(/(^|\s)#.*$/, "").trimEnd())
    .filter(line => line.trim())
    .map(line => ({ indent: line.length - line.trimStart().length, text: line.trim() }));
  let index = 0;

  const scalar = value => {
    if (/^(["']).*\1$/.test(value)) {
      return value.slice(1, -1);
    }
    return value === "true" || value === "false" ? value === "true" : value;
  };

  const readBlock = indent => (lines[index].text.startsWith("- ") ? readList(indent) : readMap(indent));

  function readList(indent) {
    const list = [];
    while (index < lines.length && lines[index].indent === indent && lines[index].text.startsWith("- ")) {
      const line = lines[index];
      const item = line.text.slice(1).trimStart();
      if (!/^[^:]+:(\s|$)/.test(item)) {
        list.push(scalar(item));
        index++;
        continue;
      }
      // "- key: value" starts a map, its keys sit in the column of "key"
      line.indent += line.text.length - item.length;
      line.text = item;
      list.push(readMap(line.indent));
    }
    return list;
  }

  function readMap(indent) {
    const map = {};
    while (index < lines.length && lines[index].indent === indent && !lines[index].text.startsWith("- ")) {
      const match = /^([^:]+):(?:\s+(.*))?$/.exec(lines[index].text);
      if (!match) {
        throw new Error(`.do/app.yaml: cannot read "${lines[index].text}"`);
      }
      index++;
      const key = match[1].trim();
      if (match[2]) {
        map[key] = scalar(match[2].trim());
        continue;
      }
      const next = lines[index];
      const nested = next && (next.indent > indent || (next.indent === indent && next.text.startsWith("- ")));
      map[key] = nested ? readBlock(next.indent) : null;
    }
    return map;
  }

  const result = lines.length ? readBlock(lines[0].indent) : {};
  if (index < lines.length) {
    throw new Error(`.do/app.yaml: cannot read "${lines[index].text}"`);
  }
  return result;
}

const spec = parseYaml(fs.readFileSync(path.join(__dirname, ".do", "app.yaml"), "utf8"));
const site = spec.static_sites?.[0] ?? {};
const publicDir = path.join(__dirname, site.source_dir ?? ".", site.output_dir ?? ".");
const errorDocument = site.error_document ?? "404.html";
// the longest prefix wins, so a rule for one path beats "/"
const rules = (spec.ingress?.rules ?? [])
  .filter(rule => rule.match?.path?.prefix)
  .map(rule => ({
    prefix: rule.match.path.prefix,
    rewrite: rule.component?.rewrite,
    preservePrefix: rule.component?.preserve_path_prefix === true,
  }))
  .sort((first, second) => second.prefix.length - first.prefix.length);

const trimSlash = value => value.replace(/\/+$/, "");

// app platform matches a prefix by path segments: /a matches /a, /a/ and /a/b
function matches(urlPath, prefix) {
  const base = trimSlash(prefix);
  return base === "" || urlPath === base || urlPath.startsWith(`${base}/`);
}

// the path the site gets after the ingress rules: the matched prefix is replaced by the rewrite,
// or cut off when there is no rewrite, and the rest of the path is kept
function route(urlPath) {
  const rule = rules.find(item => matches(urlPath, item.prefix));
  if (!rule || (rule.preservePrefix && !rule.rewrite)) {
    return urlPath;
  }
  const rest = urlPath.slice(trimSlash(rule.prefix).length).replace(/^\/+/, "");
  if (!rule.rewrite) {
    return `/${rest}`;
  }
  return rest ? `${trimSlash(rule.rewrite)}/${rest}` : rule.rewrite;
}

function contentTypeOf(file) {
  return contentTypes[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

// the file under the site folder for a url path, undefined when the path leaves the folder
function siteFile(urlPath) {
  const file = path.join(publicDir, urlPath);
  return file === publicDir || file.startsWith(publicDir + path.sep) ? file : undefined;
}

function stat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

function send(request, response, status, headers, body) {
  response.writeHead(status, { "Cache-Control": "no-store", ...headers, "Content-Length": body.length });
  response.end(request.method === "HEAD" ? undefined : body);
}

function sendText(request, response, status, text, headers = {}) {
  send(request, response, status, { "Content-Type": "text/plain; charset=utf-8", ...headers }, Buffer.from(`${text}\n`));
}

function sendFile(request, response, status, file) {
  send(request, response, status, { "Content-Type": contentTypeOf(file) }, fs.readFileSync(file));
}

function sendNotFound(request, response) {
  const page = siteFile(`/${errorDocument}`);
  if (page && stat(page)?.isFile()) {
    sendFile(request, response, 404, page);
  } else {
    sendText(request, response, 404, "not found");
  }
}

function handle(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(request, response, 405, "method not allowed", { Allow: "GET, HEAD" });
    return;
  }
  const url = new URL(request.url ?? "/", "http://localhost");
  let urlPath;
  try {
    urlPath = decodeURIComponent(url.pathname);
  } catch {
    sendText(request, response, 400, "bad url");
    return;
  }

  const routedPath = route(urlPath);
  if (routedPath !== urlPath) {
    response.routedPath = routedPath;
  }
  let file = siteFile(routedPath);
  let fileStat = file && stat(file);
  // like app platform, a folder answers with its index.html, with or without the trailing slash
  if (fileStat?.isDirectory()) {
    file = path.join(file, "index.html");
    fileStat = stat(file);
  }
  if (!fileStat?.isFile()) {
    sendNotFound(request, response);
    return;
  }
  sendFile(request, response, 200, file);
}

const server = http.createServer((request, response) => {
  response.on("finish", () => {
    const routed = response.routedPath ? ` -> ${response.routedPath}` : "";
    console.log(`${response.statusCode} ${request.method} ${request.url}${routed}  ${response.getHeader("Content-Type") ?? ""}`);
  });
  try {
    handle(request, response);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) {
      sendText(request, response, 500, "server error");
    }
  }
});

server.listen(port, host, () => {
  console.log(`test pages: http://localhost:${port}/`);
  for (const rule of rules.filter(item => item.rewrite)) {
    console.log(`  ${rule.prefix} -> ${rule.rewrite}`);
  }
});
