# FluxNotes

FluxNotes helps you turn ideas into clean, visual study notes. You type a prompt, the app builds a note structure, generates page images, and lets you save, revisit, and export everything from one place.

## For users

### What the app does
- Create a new note from the dashboard
- Generate a study outline and page-by-page visuals
- Save notes locally so you can come back later
- Open previous notes and continue from where you left off
- Export pages as PDF, PNG, or JPEG

### Download the app

Choose the version for your computer:

| Platform | Download type | What you get |
| --- | --- | --- |
| Windows | Installer | A standard Windows setup file for installing FluxNotes |
| Linux | DEB / RPM / archive | A package for Linux users or a portable archive |
| macOS | DMG | A macOS installer package |

These are the current release formats created by the project’s Electron packaging settings.

### How to use it
1. Open the app.
2. Click Create New Note.
3. Type your prompt or continue a note session.
4. Wait for the app to generate the pages.
5. Review the pages, save your note, and export when you want.

### Exporting notes
You can export your generated notes as:
- PDF
- PNG
- JPEG

### Helpful tips
- Keep your note names simple so they are easy to find later.
- If generation seems stuck, restart the app and try again with a fresh note.
- Saved notes stay on your computer, so you can reopen them anytime.

---

## For developers

### What this project is built with
- Next.js for the interface
- Electron for the desktop app
- TypeScript for app logic
- SQLite for local note storage
- Puppeteer and browser automation for the generation flow

### Main folders
```text
.
├── app/              # Frontend screens and pages
├── electron/         # Electron app logic and worker bridge
├── icons/            # App icons
├── public/           # Static assets
├── prompt.md         # Chat/AI generation instructions
├── Changelog.md      # Release notes
├── package.json      # App metadata and build settings
├── README.md         # Project docs
└── ...
```

### Run it locally
Install dependencies:
```bash
npm install
```

Start the app:
```bash
npm run dev
```

Expose the local mobile API through ngrok (including WebSocket upgrades):
```bash
export NGROK_AUTHTOKEN="your-ngrok-auth-token"
npm run dev
```

Electron starts an authenticated local WebSocket API on `127.0.0.1:8787` and
then starts the tunnel automatically when `NGROK_AUTHTOKEN` is available. On
first launch, FluxNotes generates a 16-character API token and stores it in
Electron's global user-data directory. The token is shown in Settings under
Ngrok Tunnel. The desktop UI continues to use Next.js on port `3000`; the
mobile client does not connect to that port.

The public URL printed by ngrok is the mobile API endpoint. Use its `wss://`
equivalent plus `/ws`, for example `wss://your-domain.ngrok.app/ws`.
The mobile client authenticates over that WebSocket:

```json
{"type":"auth","authToken":"the-token-shown-in-settings"}
```

The server returns `sessionId`, `token`, and `renewToken`. Send the `sessionId`
and `token` with every command:

```json
{"type":"list_notes","sessionId":"...","token":"..."}
```

Clients may send `{"type":"ping"}` periodically; the server replies with
`{"type":"pong","timestamp":...}`. The server also sends native WebSocket
ping frames every 30 seconds and closes unresponsive connections.

Use `renewToken` with a `renew` message after the access token expires. Image
URLs returned in notes already contain the matching session ID and token.

To tunnel an already-running WebSocket service, use `NGROK_PORT` with the
standalone command:
```bash
NGROK_PORT=8080 npm run ngrok
```

Set `NGROK_DOMAIN` to use a reserved ngrok domain. The Settings page can also
save a domain; when no domain is configured, ngrok uses a dynamic URL.

Useful commands:
```bash
npm run build
npm run build:next
npm run build:electron
npm run lint
```

### Build details
The app is configured to build desktop app packages for:
- Windows: NSIS installer
- Linux: DEB, RPM, and tar.gz
- macOS: DMG

These are the actual package formats from the current Electron config in [package.json](package.json).

### Developer notes
- The app starts the Electron shell and then launches the Next.js UI.
- Notes and images are stored locally and loaded back into the app when reopening a note.
- AI generation flow and browser automation live in the Electron layer.
- The app prompt contract is defined in [prompt.md](prompt.md).

---

## Contributing
If you are helping with the project, keep the experience simple for users and update [Changelog.md](Changelog.md) whenever meaningful changes are made.

## License
This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
