# Recall

A static, no-build PWA (plain ES modules, no npm). See README.md for setup.

## Names

Read NOMENCLATURE.md before writing UI text or describing a bug. In short: the
library holds **files**, and each file has four parts — **Cards**, **Notes**,
**PDFs** and **Canvas**. The code and the stored data keep the old names (`deck`,
`decks` table, `meta.notebook`, view modes `document` / `handwriting`) and must
not be renamed; only user-visible text uses the new ones.

## Checking a change

    node tools/check.mjs --quick   # static checks, no browser
    node tools/check.mjs           # everything except the release cycle

`tools/nomenclature-check.mjs` fails if user-visible text says deck, flashcard,
notebook, handwritten notes or Study Notes.
