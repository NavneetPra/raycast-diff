# Diff

A better diff extension for Raycast.

Run the **Diff** command, paste the original and changed text, and press ⌘↵ to open the diff in your browser. This extension opens a diff in-browser instead of on Raycast to increase formatting capabilities over other extension.

## Install on a Mac

Requirements: [Raycast](https://www.raycast.com) and [Node.js](https://nodejs.org) 22 or newer.

```bash
git clone https://github.com/NavneetPra/raycast-diff.git
cd raycast-diff
npm install
npm run build
```

`npm run build` installs the extension into Raycast locally. The command appears as "Diff." To update after new changes, run `npm run build` again.

To uninstall, open Raycast Settings, find Extensions, find Diff, and remove it.

## Development

```bash
npm run dev
```

This runs the extension in development mode to test changes on Raycast.
