# AGENTS.md — public-pages deployment rules
This repository contains generated GitHub Pages output. `CLAUDE.md` only imports this file with `@AGENTS.md`.

## Generated-content boundary
- Treat deployed HTML, JavaScript, vendor files, opaque `.enc` assets, and redirect pages as generated artifacts. Change them in their source repository and regenerate them.
- Never decrypt private artifacts for routine review. Do not commit plaintext research data, models, images, manifests, passwords, content keys, or local absolute paths.
- Do not modify unrelated sites while publishing one page family. Stage explicit paths only.

## FLOW AR compatibility
- Preserve `_p/flow-ar/` paths and the redirect-only `flow-ar/` entry points.
- Preserve query strings and hash fragments through every legacy redirect.
- Do not rename stable case or mode identifiers. Do not change the password, fixed salt, share-fragment format, base URL, or poster target without treating existing printed QR codes as invalid.
- Keep FLOW AR out of the public root listing. Keep private entry points `noindex`.
- Do not manually prune encrypted assets; the package generator owns the complete set.

## Release checks
- Confirm the branch and remote divergence before editing or pushing.
- Verify intended path scope, ciphertext headers, wrapper/noindex markers, plaintext-extension absence, secret/local-path absence, JavaScript syntax, LF, conflict markers, and `git diff --check`.
- Preserve `.nojekyll`; underscore-prefixed deployment paths depend on it.
- Avoid history rewrites and force-pushes unless the full multi-site impact has been explicitly reviewed.
