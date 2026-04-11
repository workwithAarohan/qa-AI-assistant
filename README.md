Playwright login test

This small project contains a Playwright script that will open the local `index.html`, fill the username/password with invalid values, click login and wait for the `#error` element to appear.

Run steps:

1. Install dependencies:

```bash
npm install
```

2. Run the test (works against the local file by default):

```bash
npm run test-login
```
```

Optional: serve the folder on http://localhost:3000 (or any URL) and run the script against it by setting the URL env var:

```bash
URL=http://localhost:3000 npm run test-login
```

Notes:
- The script defaults to the `index.html` file in the project root. If you prefer a web server, set the `URL` environment variable.
- If you want visible browser (non-headless) for debugging, edit `scripts/test-login.js` and change `chromium.launch()` to `chromium.launch({ headless: false })`.
