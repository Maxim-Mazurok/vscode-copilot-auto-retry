# Copilot Auto-Retry — Copilot Instructions

Instructions for the AI coding agent when working on this repository.

## Publishing

When publishing the extension to the VS Code Marketplace:

1. **Bump the version in `package.json` manually** (e.g., change `"version": "0.2.4"` to `"version": "0.3.0"`).
2. **Use `vsce publish`** (plain publish, no subcommand like `patch` or `minor`).
3. **Do NOT use `vsce publish patch`** or `vsce publish minor` — these commands bump the version in `package.json` automatically *before* publishing, which would cause a double version bump if you already updated the version manually.

```bash
# Correct:
npx -y @vscode/vsce publish

# WRONG — will bump version again:
npx -y @vscode/vsce publish patch
```

## Packaging

The extension has zero runtime npm dependencies. Use `--no-dependencies` if packaging separately:

```bash
npx -y @vscode/vsce package --no-dependencies
```

## Build Artifacts

The `out/` directory is not cleaned by `tsc`. After deleting or renaming source files, manually remove the corresponding `.js`/`.d.ts`/`.map` files from `out/` to avoid stale artifacts being included in the VSIX.

## Testing

Run tests with vitest (no VS Code extension host required):

```bash
npm test
```

The `vscode` module is mocked at `src/__mocks__/vscode.ts`. When adding new test files that import modules using `vscode` APIs, the mock may need to be extended with additional stubs.
