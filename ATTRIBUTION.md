# Attribution

This project is a conversion shim that makes the Immersive Translate
userscript installable as a standalone Chrome MV3 extension. It bundles
third-party code; this file records provenance.

## Immersive Translate (immersive.js, icons/icon128.png)

- Source: the publicly distributed userscript
  https://download.immersivetranslate.com/immersive-translate.user.js (v1.33.3)
- Copyright: Immersive Translate (https://immersivetranslate.com).
  All rights reserved by the respective owners.
- Only the userscript metadata block was stripped; the code is otherwise
  unmodified. This project does not circumvent any paid features —
  Pro membership is validated server-side by the upstream service.

## Tampermonkey workaround (tm-require.js)

- Source: https://github.com/Tampermonkey/utils
  (`requires/gh_2215_make_GM_xhr_more_parallel_again.js`)
- Included verbatim for Tampermonkey compatibility; it is a no-op outside
  Tampermonkey (checks `GM_info.scriptHandler` and returns early).

## Original work (MIT, see LICENSE)

- codec.js — request-body codec
- gm-shim.js — Tampermonkey GM_* API shim for Chrome MV3
- background.js — service worker (request proxy, tabs, context menus)
- manifest.json, test/, .github/, docs
