import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

function resolveUrl(relativeOrAbsolute, baseUrl) {
  if (!relativeOrAbsolute) return '';
  try {
    return new URL(relativeOrAbsolute, baseUrl).href;
  } catch {
    return relativeOrAbsolute;
  }
}

function slugToTitle(slug) {
  if (!slug) return '';
  return slug
    .replace(/[?#].*$/, '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

async function scrapeSite(browser, siteConfig) {
  console.log(`\n[Scraping] ${siteConfig.name} -> ${siteConfig.url}`);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  const items = [];

  try {
    try {
      await page.goto(siteConfig.url, { waitUntil: 'networkidle', timeout: 30000 });
    } catch {
      console.log(`[Warning] networkidle timed out for ${siteConfig.url}, proceeding with DOMContentLoaded.`);
      await page.waitForLoadState('domcontentloaded');
    }

    // Force lazy loading by scrolling
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 400;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= 2000 || totalHeight >= scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
    });
    await page.waitForTimeout(1000);

    // Evaluate elements on page
    const rawItems = await page.evaluate(
      ({ itemSelector, titleSelector, linkSelector, imageSelector, siteName, pageUrl }) => {
        const elements = Array.from(document.querySelectorAll(itemSelector)).slice(0, 15);

        function cleanText(str) {
          return str ? str.trim().replace(/\s+/g, ' ') : '';
        }

        function extractMediaUrl(container, selector) {
          const mediaEl = selector ? container.querySelector(selector) : container.querySelector('img, video');
          if (!mediaEl) return null;

          const tagName = mediaEl.tagName.toLowerCase();

          // 1. Direct and lazy attributes
          let src =
            mediaEl.getAttribute('src') ||
            mediaEl.getAttribute('data-src') ||
            mediaEl.getAttribute('data-lazy-src') ||
            mediaEl.currentSrc;

          // 2. Video poster or source
          if (tagName === 'video') {
            if (!src || src.startsWith('blob:') || src.startsWith('data:')) {
              src = mediaEl.getAttribute('poster');
            }
            if (!src) {
              const sourceEl = mediaEl.querySelector('source');
              if (sourceEl) {
                src = sourceEl.getAttribute('src') || sourceEl.getAttribute('data-src');
              }
            }
          }

          // 3. Srcset fallback
          if (!src || src.startsWith('data:image/svg')) {
            const srcset = mediaEl.getAttribute('srcset') || mediaEl.getAttribute('data-srcset');
            if (srcset) {
              const candidate = srcset.split(',')[0].trim().split(/\s+/)[0];
              if (candidate) src = candidate;
            }
          }

          return src ? src.trim() : null;
        }

        return elements.map((el, index) => {
          // Link extraction
          let href = '';
          if (linkSelector) {
            const linkEl = el.querySelector(linkSelector);
            if (linkEl) href = linkEl.getAttribute('href') || '';
          } else if (el.tagName.toLowerCase() === 'a') {
            href = el.getAttribute('href') || '';
          } else {
            const anchor = el.querySelector('a');
            if (anchor) href = anchor.getAttribute('href') || '';
          }

          // Image / Video extraction
          const mediaUrl = extractMediaUrl(el, imageSelector);

          // Title extraction
          let title = '';
          if (titleSelector) {
            const titleEl = el.querySelector(titleSelector);
            if (titleEl) {
              if (titleEl.tagName.toLowerCase() === 'img') {
                title = titleEl.getAttribute('alt') || titleEl.getAttribute('title') || '';
              } else {
                title = cleanText(titleEl.innerText || titleEl.textContent || '');
              }
            }
          }

          if (!title) {
            // Fallback 1: Any img alt in container
            const img = el.querySelector('img');
            if (img && img.getAttribute('alt')) {
              title = cleanText(img.getAttribute('alt'));
            }
          }

          if (!title) {
            // Fallback 2: Any text in element
            title = cleanText(el.innerText || el.textContent || '');
          }

          return {
            site: siteName,
            title,
            link: href,
            mediaUrl,
            rawHtml: el.outerHTML.slice(0, 300),
          };
        });
      },
      {
        itemSelector: siteConfig.itemSelector,
        titleSelector: siteConfig.titleSelector,
        linkSelector: siteConfig.linkSelector,
        imageSelector: siteConfig.imageSelector,
        siteName: siteConfig.name,
        pageUrl: siteConfig.url,
      }
    );

    for (let i = 0; i < rawItems.length; i++) {
      const raw = rawItems[i];
      const fullLink = resolveUrl(raw.link, siteConfig.url);
      const fullMedia = resolveUrl(raw.mediaUrl, siteConfig.url);

      let finalTitle = raw.title;
      if (!finalTitle && fullLink) {
        const segments = new URL(fullLink).pathname.split('/').filter(Boolean);
        const lastSlug = segments[segments.length - 1];
        if (lastSlug) {
          finalTitle = slugToTitle(lastSlug);
        }
      }
      if (!finalTitle) {
        finalTitle = `${siteConfig.name} Item #${i + 1}`;
      }

      if (fullLink) {
        items.push({
          site: raw.site,
          title: finalTitle,
          link: fullLink,
          mediaUrl: fullMedia,
          pubDate: new Date().toUTCString(),
        });
      }
    }

    console.log(`[Success] Found ${items.length} items for ${siteConfig.name}`);
  } catch (err) {
    console.error(`[Error] Failed scraping ${siteConfig.name}:`, err.message);
  } finally {
    await context.close();
  }

  return items;
}

function generateRssXml(items) {
  const buildDate = new Date().toUTCString();

  const xmlItems = items
    .map((item) => {
      const isVideo = item.mediaUrl && (item.mediaUrl.endsWith('.mp4') || item.mediaUrl.endsWith('.webm'));
      let mediaMarkup = '';
      if (item.mediaUrl) {
        if (isVideo) {
          mediaMarkup = `<p><video src="${escapeXml(item.mediaUrl)}" controls style="max-width:100%;height:auto;"></video></p>`;
        } else {
          mediaMarkup = `<p><img src="${escapeXml(item.mediaUrl)}" alt="${escapeXml(item.title)}" style="max-width:100%;height:auto;" /></p>`;
        }
      }

      const description = `<![CDATA[${mediaMarkup}<p><a href="${escapeXml(item.link)}" target="_blank" rel="noopener noreferrer">Bekijk op ${escapeXml(item.site)}</a></p>]]>`;

      return `    <item>
      <title><![CDATA[${item.title}]]></title>
      <link>${escapeXml(item.link)}</link>
      <guid isPermaLink="true">${escapeXml(item.link)}</guid>
      <pubDate>${item.pubDate}</pubDate>
      <description>${description}</description>
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Visual Feeds Hub</title>
    <link>https://github.com</link>
    <description>Automatisch gegenereerde RSS-feed voor visuele inspiratiesites</description>
    <language>nl</language>
    <lastBuildDate>${buildDate}</lastBuildDate>
    <atom:link href="feed.xml" rel="self" type="application/rss+xml"/>
${xmlItems}
  </channel>
</rss>
`;
}

async function main() {
  const configPath = path.join(__dirname, 'sites.json');
  const rawConfig = await fs.readFile(configPath, 'utf8');
  const sites = JSON.parse(rawConfig);

  console.log(`Starting scraper with ${sites.length} sites configured...`);

  const browser = await chromium.launch({
    headless: true,
  });

  const allItems = [];

  try {
    for (const site of sites) {
      const siteItems = await scrapeSite(browser, site);
      allItems.push(...siteItems);
    }
  } finally {
    await browser.close();
  }

  const publicDir = path.join(__dirname, 'public');
  await fs.mkdir(publicDir, { recursive: true });

  const xmlContent = generateRssXml(allItems);
  const feedPath = path.join(publicDir, 'feed.xml');
  await fs.writeFile(feedPath, xmlContent, 'utf8');

  console.log(`\n Feed written successfully to ${feedPath} with ${allItems.length} total items.`);
}

main().catch((err) => {
  console.error('Fatal error running scraper:', err);
  process.exit(1);
});
