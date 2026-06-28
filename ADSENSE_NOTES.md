# AI Tian AdSense Setup Notes

This site is prepared for AdSense review, but the live AdSense publisher ID is not included yet.

Before applying or after approval:

1. Keep `privacy.html`, `terms.html`, `about.html`, and `contact.html` live and reachable from the footer.
2. Replace `ads.txt` with the exact line provided by your Google AdSense account.
3. Add the AdSense script to `index.html` only after you have the real publisher ID:

```html
<script async
  src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-YOUR_PUBLISHER_ID"
  crossorigin="anonymous"></script>
```

4. Replace the hidden `.ad-slot` sections in `index.html` with official `<ins class="adsbygoogle">` units.
5. Submit `https://aitian.site/sitemap.xml` in Google Search Console.
6. Do not click your own ads or ask others to click ads.

