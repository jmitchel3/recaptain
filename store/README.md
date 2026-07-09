# Chrome Web Store assets

Everything needed to publish Recaptain to the Chrome Web Store: the listing copy,
the privacy policy, and the image assets (plus the sources that generate them).

## Contents

```
store/
├── listing.md            # all listing text + permission & data-disclosure answers
├── privacy-policy.md     # host this at a public URL; paste the URL into the listing
├── build-assets.mjs      # renders src/*.html → out/*.png at exact CWS dimensions
├── src/                  # HTML sources for every image (edit these, then rebuild)
│   ├── base.css
│   ├── screenshot-1-hero.html … screenshot-5-replay.html
│   ├── promo-small.html
│   └── promo-marquee.html
└── out/                  # generated uploadables (regenerate any time)
    ├── store-icon-128.png            128x128   store icon
    ├── screenshot-1-hero.png         1280x800
    ├── screenshot-2-capture.png      1280x800
    ├── screenshot-3-privacy.png      1280x800
    ├── screenshot-4-bundle.png       1280x800
    ├── screenshot-5-replay.png       1280x800
    ├── promo-small-440x280.png       440x280   small promo tile
    └── promo-marquee-1400x560.png    1400x560  marquee promo tile
```

## Regenerate the images

```bash
node store/build-assets.mjs
```

Uses the Playwright chromium build (already a dev dependency) to screenshot each
HTML source at its exact Chrome Web Store dimension. Edit anything under `src/`
and rerun. Dimensions are locked in `build-assets.mjs`.

## Chrome Web Store requirements, and what maps where

| Asset | Requirement | This repo |
|---|---|---|
| Store icon | 128x128 PNG | `out/store-icon-128.png` (the real extension icon) |
| Screenshots | 1280x800 or 640x400, 1 to 5 | `out/screenshot-1..5.png` (five at 1280x800) |
| Small promo tile | 440x280 PNG | `out/promo-small-440x280.png` |
| Marquee promo tile | 1400x560 PNG (optional, for featuring) | `out/promo-marquee-1400x560.png` |
| Listing text | name, summary ≤132 chars, description | `listing.md` |
| Privacy policy URL | required for broad host permissions | host `privacy-policy.md`, paste URL |

## Upload checklist

1. `npm run build` → produces `dist/`.
2. Zip `dist/` and upload as the extension package.
3. Fill the **Store listing** tab from `listing.md`; upload icon, 5 screenshots,
   and both promo tiles from `out/`.
4. Fill the **Privacy practices** tab from `listing.md` (single purpose, the eight
   permission justifications, the three data-use certifications).
5. Host `privacy-policy.md` publicly and paste its URL.
6. Submit for review.
