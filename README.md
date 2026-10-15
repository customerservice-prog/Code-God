# Code God · Pineda Builder

A self-hosted AI coding workspace. Bring a GitHub repository, a ZIP, a folder, or individual source files. Describe what you want to build or fix, inspect the real file changes, restore a previous version, and export the code or open a draft pull request.

This is a working first release, not a feature-equivalent replacement for Codex. The coding model is supplied separately. The interface does not generate code unless a model is connected.

The interface opens to a chat: a conversation in the middle, recent projects in the sidebar, and a message box at the bottom. Describe a project to create it from your first message, paste a GitHub link to import it, or use the **+** button to attach source files, a folder, or a ZIP. In an existing chat, attachments are added to that project; replacing an existing file requires confirmation and keeps a restore point. **Files & preview** opens the optional code/preview/history panel. Enter sends a message; Shift+Enter adds a new line. Unsent drafts stay in the current browser session, and AI activity appears in the conversation while work runs.

## Start on Windows

1. Install **Node.js 24 or newer** from [nodejs.org](https://nodejs.org/).
2. Download this repository as a ZIP from **Code → Download ZIP** and extract it.
3. Double-click **START-CODE-GOD.bat**.
4. Open the private access link printed in that terminal. Keep the terminal open.
5. Open **Connections & setup** to connect the AI and optional check runner.

The app itself has no npm dependencies. You do not need to run `npm install`.

On Linux/macOS:

```sh
node --env-file-if-exists=.env server.mjs
```

Default workspace: `http://127.0.0.1:4310`. The startup link includes a private access token in its fragment. The page removes the fragment and keeps the token in this browser tab’s session storage. The server prints the link again after every restart. Closing the tab clears its browser session token.

## Connect the coding AI

The default provider is a local [Ollama](https://docs.ollama.com/quickstart) server at `http://127.0.0.1:11434`. Install and start Ollama, then install a coding model that supports **tool calling** and fits your computer’s available memory. Refresh connections and choose the installed model in the chat composer.

Code God discovers the installed models through `/api/tags` and uses Ollama’s `/api/chat` tool interface. Model capability and hardware determine coding quality and speed. Local inference does not require a paid model API key; it still needs your own hardware, storage, and electricity.

An alternative server that implements the chat-completions tool interface can be configured by copying `.env.example` to `.env`:

```dotenv
CG_AI_PROVIDER=compatible
CG_AI_URL=http://127.0.0.1:8080/v1
CG_MODEL=your-model-name
```

Set `CG_AI_KEY` on the server only if that provider requires it. That provider may charge for use. There is no subscription-account connection to ChatGPT or Codex in this release.

## Build something

- **Fresh start:** choose a working HTML/CSS/JavaScript website or a blank project for any language.
- **GitHub:** paste a plain `https://github.com/owner/repository` URL. Git must be installed. The default branch is copied without running project code or installing packages.
- **Upload:** choose a ZIP, folder, or individual files. A single enclosing ZIP folder is removed automatically.
- **Chat:** ask for a feature or fix. The agent can list and search files, read and write files, replace an exact text match, delete a file, and request a supported check.
- **Review:** inspect the editor and the original/current file comparison. A restore point is saved before every agent task and manual file edit. The original project and 30 recent restore points are kept.
- **Take the code:** download an updated ZIP. For a GitHub import, optionally create a new branch and draft pull request.

The agent is limited to one project, 24 model rounds and 60 tool calls per request. Up to two tasks can run across projects. Stop interrupts the active model request and prevents subsequent tool calls. Changes already made are kept and can be restored. After a server restart, unfinished tasks are marked interrupted rather than silently claimed as completed.

## Preview and checks

**Preview** renders static HTML from the project root or `dist`, `out`, `build`, or `public`. Use relative asset paths. Preview JavaScript runs in a sandboxed iframe on a separate localhost port; external connections, forms, and access to the workspace are blocked. The preview URL expires after one hour or when refreshed. This does not run Next.js, Python, database servers, or other backend applications. Such projects can be edited and exported but need their own runtime to preview.

**Checks** require a running Docker daemon with the relevant image preloaded:

```sh
docker pull node:24-bookworm-slim
docker pull python:3.12-slim
```

Available checks: JavaScript syntax, Node tests, `npm test`, `npm run build`, and Python unittest discovery. These are fixed commands, not an unrestricted host terminal. Project files are copied into a disposable container with no network, a read-only input mount, a non-root user, dropped capabilities, memory/CPU/process limits, and a 90-second timeout. The container cannot write back to the source project.

Package installation is not included. Checks needing third-party dependencies may fail with missing-module errors. Missing Docker or images is shown as unavailable/failed; project code is never run on the host as a fallback. Syntax checks do not validate TypeScript/JSX or prove application behavior.

## Optional GitHub writes

Set a fine-grained `GITHUB_TOKEN` in `.env`, restricted to selected repositories. Private imports need Contents read access. Creating branches and draft pull requests also needs Contents and Pull requests write access.

The token stays server-side. The agent has no GitHub-write tool. Only the owner’s **Create draft PR** action publishes changes. Each action creates a new `code-god/...` branch rooted at the imported commit, then opens a draft PR against the imported default branch. It never pushes to or merges the default branch. If the remote repository has changed, review and resolve conflicts in GitHub before merging. If opening a PR fails after branch creation, the error identifies the saved branch.

## Data and limits

SQLite stores project metadata, messages, task activity, and compressed restore points. Working files are under `data/workspaces/`. Back up the **whole `data/` directory while the server is stopped**; source exports do not include conversations or history. `.env` and `data/` are excluded from Git. Store a separate backup of `.env` if you use server credentials.

Imports are limited to 2,000 files, 2 MB per file, and 20 MB total excluding ignored files. The text editor and agent can read/write up to 256 KB per text file. Binary files can be imported and exported but are not text-editable. Dependencies, Git history, common credential files, and symlinks are excluded or rejected. This filter does not detect every possible secret; only import code you intend to send to your configured model server.

## Pineda Cloud

The app runs as a normal Node process and uses a configurable persistent data directory. No Railway, Supabase, Vercel, or cloud database account is required. It is not yet wired into a Pineda Cloud deployment API; there is no deploy button that pretends otherwise.

This release defaults to a **single-owner local workspace**. Binding beyond localhost requires a fixed `CG_AUTH_TOKEN` of at least 32 characters. A remote deployment additionally needs HTTPS, `CG_PUBLIC_ORIGIN`, authentication appropriate to its audience, persistent backups, and a separately routed preview origin/isolated execution worker. The current preview server listens only on localhost and is intended for the same computer as the browser. Do not expose a Docker socket to this application or mount one into an internet-facing container.

## Verify

```sh
npm run check
npm test
```

The test suite covers archive corruption/traversal/symlink rejection, file editing, version recovery, GitHub URL validation, draft PR construction, authenticated HTTP import/edit/export/preview flows, and an actual agent file edit against a deterministic mock model server. The mock verifies the tool loop without downloading a model or claiming its responses are live AI. Real model inference, Docker execution, and GitHub credentials require their own connected services and are not established by these tests. Browser rendering is not covered by the Node suite.

API references: [Ollama chat](https://docs.ollama.com/api/chat), [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling), [Node SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).
