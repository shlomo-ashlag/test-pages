# Test Pages

Static pages for checking the browser extension by hand. Each test is a folder in `public/` with its own `index.html`, and the home page links to all of them.

## Tests

| Page | Ticket | What it checks |
| --- | --- | --- |
| `/test-download-pdf/` | ABS-5434 | Firefox saves a PDF sent by a script URL (`show_temp.pl?file=...`) with a `.pdf` name. |

## Run locally

Needs Node.js 18 or newer, nothing to install.

```bash
node serve.js
```

Then open http://localhost:8080. Set `PORT` to use another port.

`serve.js` reads `.do/app.yaml`, so the local site answers the same way as on DigitalOcean: the same folder, the same 404 page and the same rewrite rules.

## Add a test

1. Create `public/<test-name>/index.html`. Copy an existing test page to keep the look.
2. Add a card to `public/index.html` and a row to the table above.
3. Start every link in the page with `/`. App Platform also serves `/<test-name>` without the trailing slash, and relative links would break there.

## URLs that answer with another file

A static site takes `Content-Type` from the file extension and cannot set other headers. When a test needs a URL such as `/cgi-bin/show_temp.pl` that answers with a PDF, add a rewrite rule to `.do/app.yaml` that points the URL to a real file:

```yaml
- match:
    path:
      prefix: /test-download-pdf/cgi-bin/show_temp.pl
  component:
    name: site
    rewrite: /test-download-pdf/files/sample.pdf
```

The browser keeps the original URL, and the extension of the target file sets the type. Keep these rules above the `/` rule. Headers such as `Content-Disposition` cannot be sent this way.

## Deploy to DigitalOcean

The site is an App Platform static site, described by `.do/app.yaml`.

1. In the DigitalOcean control panel, give App Platform access to this GitHub repo (once).
2. Create the app: `doctl apps create --spec .do/app.yaml`.
3. Pushes to `main` redeploy the files. Changes to `.do/app.yaml` are not picked up on push: apply them with `doctl apps update <app id> --spec .do/app.yaml`, or paste the file in the app's Settings > App Spec.
4. After the first deploy, open `/test-download-pdf/`. Each case checks what the server sends, and all checks must be green.
