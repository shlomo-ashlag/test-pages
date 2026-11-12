# Test Pages

Static pages for the QA team: test pages for checking the browser extension by hand, and small tools. Each page is a folder in `public/` with its own `index.html`, and the home page links to all of them.

## Tests

| Page | Ticket | What it checks |
| --- | --- | --- |
| `/test-download-pdf/` | ABS-5434 | Firefox saves a PDF sent by a script URL (`show_temp.pl?file=...`) with a `.pdf` name. |

## Tools

| Page | What it does |
| --- | --- |
| `/tool-proxy-access/` | Shows and changes who may open the work apps through the QA proxy: the members of a Google group and the addresses in an access level. |

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

A tool is added the same way: the folder is `public/tool-<name>/`, and its card goes to the Tools list of the home page.

## Set up the proxy access tool

The tool has no backend. The person who uses it signs in with Google in the browser, and the browser calls the Admin SDK and the Access Context Manager API with that sign-in.

In the Google Cloud console, in one project of your organization:

1. Enable **Admin SDK API** and **Access Context Manager API**.
2. Set the OAuth consent screen to **Internal**, so only accounts of your organization can sign in. Add the scopes `https://www.googleapis.com/auth/admin.directory.group.member` and `https://www.googleapis.com/auth/cloud-platform`.
3. Create an OAuth client ID of the type **Web application**. In **Authorized JavaScript origins** add the site address, for example `https://<app>.ondigitalocean.app`, and `http://localhost:8080` for the local server. An origin has no path and no slash at the end. Redirect URIs are not needed.

Then fill in `config` at the top of `public/tool-proxy-access/proxy-access.js`:

| Value | Where it comes from |
| --- | --- |
| `clientId` | The client ID from step 3. |
| `groupEmail` | The email of the Google group. |
| `policyId` | The number that `gcloud access-context-manager policies list` shows. |
| `accessLevelName` | The short name of the level from `gcloud access-context-manager levels list --policy=<policyId>`, not its title. |

The account that signs in needs the Groups Admin role in Google Workspace and the Access Context Manager Admin role (`roles/accesscontextmanager.policyAdmin`) on the organization in Google Cloud.

Keep in mind:

- The values in `config` are not secrets, but they are public with the site.
- The Google token allows everything the admin may do in Google Cloud. It stays in the memory of the page and goes only to Google.
- Google trusts the whole site address, not one page. Any page of this site could ask for the same sign-in, so do not add scripts from other sites to any page here.

## URLs that answer with another file

A static site takes `Content-Type` from the file extension and cannot set other headers. When a test needs a URL such as `/cgi-bin/show_temp.pl` that answers with a PDF, add a rewrite rule to `.do/app.yaml` that points the URL to a real file:

```yaml
- match:
    path:
      prefix: /test-download-pdf/cgi-bin/show_temp.pl
  component:
    name: test-pages-public
    rewrite: /test-download-pdf/files/sample.pdf
```

The browser keeps the original URL, and the extension of the target file sets the type. Keep these rules above the `/` rule. Headers such as `Content-Disposition` cannot be sent this way.

## Deploy to DigitalOcean

The site is an App Platform static site, described by `.do/app.yaml`.

1. In the DigitalOcean control panel, give App Platform access to this GitHub repo (once).
2. Create the app: `doctl apps create --spec .do/app.yaml`.
3. Pushes to `main` redeploy the files. Changes to `.do/app.yaml` are not picked up on push: apply them with `doctl apps update <app id> --spec .do/app.yaml`, or paste the file in the app's Settings > App Spec.
4. After the first deploy, open `/test-download-pdf/`. Each case checks what the server sends, and all checks must be green.
